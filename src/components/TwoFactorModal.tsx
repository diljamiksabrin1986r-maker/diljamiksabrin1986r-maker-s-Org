import React, { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { ShieldCheck, KeyRound } from 'lucide-react';
import { buildOtpAuthUri, generateBase32Secret, generateTOTPCode, verifyTOTPCode } from '../utils/totp';

interface TwoFactorModalProps {
  email: string;
  existingSecret?: string;
  mode: 'setup' | 'verify';
  onVerified: (secretUsed: string) => void;
  onCancel?: () => void;
}

export const TwoFactorModal: React.FC<TwoFactorModalProps> = ({
  email,
  existingSecret,
  mode,
  onVerified,
  onCancel,
}) => {
  const [secret] = useState(() => existingSecret || generateBase32Secret());
  const [qrDataUrl, setQrDataUrl] = useState<string>('');
  const [liveCode, setLiveCode] = useState<string>('');
  const [inputCode, setInputCode] = useState<string>('');
  const [error, setError] = useState<string>('');
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    const uri = buildOtpAuthUri(email, secret);
    QRCode.toDataURL(uri, { width: 180, margin: 1 })
      .then(setQrDataUrl)
      .catch(() => setQrDataUrl(''));
  }, [email, secret]);

  useEffect(() => {
    let active = true;
    const refresh = async () => {
      const code = await generateTOTPCode(secret);
      if (active) setLiveCode(code);
    };
    refresh();
    const timer = setInterval(refresh, 5000);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [secret]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setChecking(true);
    setError('');
    try {
      const ok = await verifyTOTPCode(secret, inputCode);
      if (!ok) {
        setError('Неверный 6-значный код TOTP. Проверьте код и повторите.');
        return;
      }
      onVerified(secret);
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/60 p-4">
      <div className="w-full max-w-md bg-white border border-slate-200 rounded-xl p-6 space-y-5">
        <div className="flex items-start gap-3">
          <div className="p-2.5 rounded-lg bg-emerald-50 text-emerald-700">
            <ShieldCheck className="w-5 h-5" />
          </div>
          <div>
            <h3 className="text-lg font-semibold text-slate-900">
              {mode === 'setup'
                ? 'Настройка двухфакторной защиты (2FA)'
                : 'Подтверждение входа 2FA'}
            </h3>
            <p className="text-sm text-slate-600 mt-0.5">
              {mode === 'setup'
                ? 'Отсканируйте QR-код в приложении-аутентификаторе (Google Authenticator / 2FAS) или введите код ниже.'
                : `Введите 6-значный TOTP-код для аккаунта ${email}.`}
            </p>
          </div>
        </div>

        {mode === 'setup' && (
          <div className="flex flex-col sm:flex-row items-center gap-4 p-4 bg-slate-50 border border-slate-200 rounded-lg">
            {qrDataUrl ? (
              <img
                src={qrDataUrl}
                alt="QR код 2FA"
                className="w-32 h-32 rounded-lg border border-slate-200 bg-white p-1 shrink-0"
              />
            ) : (
              <div className="w-32 h-32 bg-slate-200 rounded-lg shrink-0" />
            )}
            <div className="space-y-2 text-xs text-slate-600 min-w-0">
              <div>
                <span className="text-slate-500">Секретный ключ:</span>
                <div className="font-mono font-semibold text-slate-900 break-all mt-0.5">
                  {secret}
                </div>
              </div>
              <div className="pt-1 border-t border-slate-200">
                <span className="text-slate-500">Текущий код аутентификатора:</span>
                <div className="font-mono text-base font-bold text-emerald-700 tracking-widest mt-0.5">
                  {liveCode}
                </div>
              </div>
            </div>
          </div>
        )}

        {mode === 'verify' && (
          <div className="p-3 bg-slate-50 border border-slate-200 rounded-lg flex items-center justify-between text-xs text-slate-600">
            <span className="flex items-center gap-1.5">
              <KeyRound className="w-4 h-4 text-slate-500" />
              Текущий TOTP-токен устройства:
            </span>
            <span className="font-mono font-bold text-sm text-emerald-700 tracking-wider">
              {liveCode}
            </span>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label className="block text-sm font-medium text-slate-700 mb-1.5">
              6-значный код подтверждения
            </label>
            <input
              type="text"
              inputMode="numeric"
              maxLength={6}
              value={inputCode}
              onChange={(e) => setInputCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
              placeholder="000000"
              className="w-full px-4 py-2.5 font-mono text-lg tracking-widest text-center bg-white border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-600"
              autoFocus
            />
          </div>

          {error && (
            <p className="text-xs font-medium text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">
              {error}
            </p>
          )}

          <div className="flex items-center justify-end gap-3">
            {onCancel && (
              <button
                type="button"
                onClick={onCancel}
                className="px-4 py-2 text-sm font-medium text-slate-700 hover:text-slate-900"
              >
                Отмена
              </button>
            )}
            <button
              type="submit"
              disabled={checking || inputCode.length !== 6}
              className="px-5 py-2 text-sm font-medium text-white bg-emerald-600 rounded-lg hover:bg-emerald-700 disabled:opacity-50 transition-colors"
            >
              Подтвердить код
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
