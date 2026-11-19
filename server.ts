import express from 'express';
import http from 'http';
import crypto from 'crypto';
import dotenv from 'dotenv';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';
import { GoogleGenAI, Type } from '@google/genai';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const BOOTSTRAPPED_OWNER_EMAIL = 'diljamiksabrin1986r@gmail.com';
const GOOGLE_SECURETOKEN_CERTS_URL =
  'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';

interface FirebaseAppletConfig {
  projectId: string;
  firestoreDatabaseId?: string;
}

const firebaseConfig: FirebaseAppletConfig = JSON.parse(
  fs.readFileSync(path.resolve(__dirname, 'firebase-applet-config.json'), 'utf-8')
);

let cachedCerts: { certs: Record<string, string>; expiresAt: number } | null = null;

async function getGooglePublicCerts(forceRefresh = false): Promise<Record<string, string>> {
  if (!forceRefresh && cachedCerts && Date.now() < cachedCerts.expiresAt) {
    return cachedCerts.certs;
  }
  const resp = await fetch(GOOGLE_SECURETOKEN_CERTS_URL);
  if (!resp.ok) {
    throw new Error('Не удалось загрузить сертификаты проверки авторизации Firebase.');
  }
  const cacheControl = resp.headers.get('cache-control') || '';
  const maxAgeMatch = cacheControl.match(/max-age=(\d+)/i);
  const maxAgeSec = maxAgeMatch ? Number(maxAgeMatch[1]) : 3600;
  const certs = (await resp.json()) as Record<string, string>;
  cachedCerts = {
    certs,
    expiresAt: Date.now() + Math.max(60, maxAgeSec - 30) * 1000,
  };
  return certs;
}

interface VerifiedFirebasePayload {
  sub: string;
  aud: string;
  iss: string;
  exp: number;
  iat: number;
  email?: string;
  email_verified?: boolean;
}

async function verifyFirebaseIdToken(idToken: string): Promise<VerifiedFirebasePayload> {
  const parts = idToken.split('.');
  if (parts.length !== 3) {
    throw new Error('Некорректный формат токена авторизации.');
  }
  const [headerB64, payloadB64, sigB64] = parts;
  const header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8')) as {
    alg?: string;
    kid?: string;
  };
  if (header.alg !== 'RS256' || !header.kid) {
    throw new Error('Неподдерживаемый алгоритм подписи токена.');
  }

  let certs = await getGooglePublicCerts(false);
  let cert = certs[header.kid];
  if (!cert) {
    certs = await getGooglePublicCerts(true);
    cert = certs[header.kid];
  }
  if (!cert) {
    throw new Error('Ключ подписи токена не найден.');
  }

  const verifier = crypto.createVerify('RSA-SHA256');
  verifier.update(`${headerB64}.${payloadB64}`);
  verifier.end();
  const isValidSig = verifier.verify(cert, Buffer.from(sigB64, 'base64url'));
  if (!isValidSig) {
    throw new Error('Подпись токена авторизации недействительна.');
  }

  const payload = JSON.parse(
    Buffer.from(payloadB64, 'base64url').toString('utf8')
  ) as VerifiedFirebasePayload;

  const nowSec = Math.floor(Date.now() / 1000);
  const expectedIss = `https://securetoken.google.com/${firebaseConfig.projectId}`;
  if (payload.aud !== firebaseConfig.projectId) {
    throw new Error('Токен не соответствует проекту магазина.');
  }
  if (payload.iss !== expectedIss) {
    throw new Error('Недопустимый издатель токена.');
  }
  if (!payload.sub || typeof payload.sub !== 'string') {
    throw new Error('Отсутствует идентификатор пользователя в токене.');
  }
  if (typeof payload.exp !== 'number' || payload.exp <= nowSec) {
    throw new Error('Срок действия сессии истек. Обновите страницу и повторите вход.');
  }
  if (typeof payload.iat !== 'number' || payload.iat > nowSec + 300) {
    throw new Error('Некорректное время выпуска токена.');
  }
  if (payload.email_verified !== true) {
    throw new Error('Email сотрудника не подтвержден.');
  }

  return payload;
}

async function verifyAdminOrOwnerRole(
  uid: string,
  email: string | undefined,
  idToken: string
): Promise<boolean> {
  if (email && email.toLowerCase() === BOOTSTRAPPED_OWNER_EMAIL) {
    return true;
  }
  const databaseId = firebaseConfig.firestoreDatabaseId || '(default)';
  const docUrl = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(
    firebaseConfig.projectId
  )}/databases/${encodeURIComponent(databaseId)}/documents/users/${encodeURIComponent(uid)}`;

  const resp = await fetch(docUrl, {
    headers: {
      Authorization: `Bearer ${idToken}`,
    },
  });
  if (!resp.ok) {
    return false;
  }
  const docJson = (await resp.json()) as {
    fields?: {
      role?: { stringValue?: string };
      active?: { booleanValue?: boolean };
    };
  };
  const role = docJson.fields?.role?.stringValue;
  const active = docJson.fields?.active?.booleanValue === true;
  return active && (role === 'owner' || role === 'admin');
}

const requireAdminStaff: express.RequestHandler = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization || '';
    if (!authHeader.startsWith('Bearer ')) {
      res.status(401).json({
        error: 'Требуется авторизация сотрудника для AI-распознавания накладных.',
      });
      return;
    }
    const idToken = authHeader.slice(7).trim();
    if (!idToken) {
      res.status(401).json({ error: 'Пустой токен авторизации.' });
      return;
    }

    const payload = await verifyFirebaseIdToken(idToken);
    const hasAccess = await verifyAdminOrOwnerRole(payload.sub, payload.email, idToken);
    if (!hasAccess) {
      res.status(403).json({
        error: 'Доступ к AI-распознаванию накладных разрешен только администраторам и руководителю.',
      });
      return;
    }
    next();
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Ошибка проверки прав доступа.';
    res.status(401).json({ error: message });
  }
};

const app = express();
const PORT = 3000;

app.use(express.json({ limit: '25mb' }));

function getGeminiClient() {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY не настроен на сервере. Проверьте Settings > Secrets.');
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, timestamp: new Date().toISOString() });
});

app.post('/api/invoice/parse', requireAdminStaff, async (req, res) => {
  try {
    const { imageBase64, mimeType } = req.body as {
      imageBase64?: string;
      mimeType?: string;
    };

    if (!imageBase64 || typeof imageBase64 !== 'string') {
      res.status(400).json({ error: 'Не передано изображение накладной.' });
      return;
    }

    const cleanBase64 = imageBase64.includes(',')
      ? imageBase64.split(',')[1]
      : imageBase64;

    const ai = getGeminiClient();

    const response = await ai.models.generateContent({
      model: 'gemini-4-hydrogen',
      contents: {
        parts: [
          {
            inlineData: {
              mimeType: mimeType || 'image/jpeg',
              data: cleanBase64,
            },
          },
          {
            text:
              'Ты бухгалтер и товаровед продуктового магазина в Таджикистане. Валюта магазина — сомони (TJS / смн). Проанализируй фотографию накладной поставщика и извлеки точные данные о поставщике, номере накладной и каждой товарной позиции. ' +
              'Если срок годности не указан явно, оставь пустую строку. Если розничная цена не указана в накладной, рассчитай рекомендуемую розничную цену с наценкой +25% от закупочной цены. Все цены передавай числами в сомони. ' +
              'Категорию выбери из: Выпечка, Молочные, Овощи и фрукты, Бакалея, Напитки, Детские товары, Кондитерка, Хозтовары. ' +
              'Единицу измерения выбери строго из: шт, кг, л, уп.',
          },
        ],
      },
      config: {
        responseMimeType: 'application/json',
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            supplierName: {
              type: Type.STRING,
              description: 'Наименование поставщика',
            },
            invoiceNumber: {
              type: Type.STRING,
              description: 'Номер накладной',
            },
            invoiceDate: {
              type: Type.STRING,
              description: 'Дата накладной в формате YYYY-MM-DD',
            },
            items: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  name: { type: Type.STRING },
                  barcode: { type: Type.STRING },
                  category: { type: Type.STRING },
                  unit: { type: Type.STRING },
                  quantity: { type: Type.NUMBER },
                  costPrice: { type: Type.NUMBER },
                  retailPrice: { type: Type.NUMBER },
                  expiryDate: { type: Type.STRING },
                },
                required: ['name', 'category', 'unit', 'quantity', 'costPrice', 'retailPrice'],
              },
            },
          },
          required: ['supplierName', 'invoiceNumber', 'items'],
        },
      },
    });

    const rawText = (response.text ?? '').trim();
    if (!rawText) {
      res.status(502).json({ error: 'Модель не вернула распознанные данные.' });
      return;
    }

    const parsed = JSON.parse(rawText);
    res.json(parsed);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Ошибка распознавания накладной';
    console.error('Invoice parse error:', message);
    res.status(500).json({ error: message });
  }
});

async function startServer() {
  const isProd = process.env.NODE_ENV === 'production';
  const httpServer = http.createServer(app);

  if (!isProd) {
    const { createServer: createViteServer } = await import('vite');
    const hmrDisabled = process.env.DISABLE_HMR === 'true';
    const vite = await createViteServer({
      server: {
        middlewareMode: true,
        hmr: hmrDisabled ? false : { server: httpServer },
        ws: hmrDisabled ? false : undefined,
      },
      appType: 'spa',
    });

    if (hmrDisabled) {
      app.get('/@vite/client', async (_req, res, next) => {
        try {
          const result = await vite.transformRequest('/@vite/client');
          if (!result) return next();
          const patched = result.code.replace(
            'await wsTransport.connect(handlers);',
            'return;'
          );
          res.type('application/javascript').send(patched);
        } catch (err) {
          next(err);
        }
      });
    }

    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(__dirname, 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      const indexFile = path.join(distPath, 'index.html');
      if (fs.existsSync(indexFile)) {
        res.sendFile(indexFile);
      } else {
        res.status(404).send('Not found');
      }
    });
  }

  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`FreshMart Pro server listening on http://0.0.0.0:${PORT}`);
  });
}

startServer();
