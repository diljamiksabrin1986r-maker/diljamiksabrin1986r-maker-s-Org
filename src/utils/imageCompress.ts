/**
 * Compresses an uploaded image file to a compact JPEG DataURL (<= 220 KB)
 * suitable for storing safely in Firestore product documents and offline cache.
 */
export function compressProductImageFile(file: File, maxSide = 360): Promise<string> {
  return new Promise((resolve, reject) => {
    if (!file.type.startsWith('image/')) {
      reject(new Error('Выберите файл изображения (JPG, PNG, WebP).'));
      return;
    }

    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Не удалось прочитать файл изображения.'));
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('Не удалось декодировать изображение.'));
      img.onload = () => {
        const scale = Math.min(1, maxSide / Math.max(img.width || 1, img.height || 1));
        const width = Math.max(1, Math.round(img.width * scale));
        const height = Math.max(1, Math.round(img.height * scale));
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (!ctx) {
          reject(new Error('Не удалось обработать изображение.'));
          return;
        }
        ctx.drawImage(img, 0, 0, width, height);
        const primary = canvas.toDataURL('image/jpeg', 0.72);
        if (primary.length <= 220000) {
          resolve(primary);
          return;
        }
        const fallback = canvas.toDataURL('image/jpeg', 0.45);
        if (fallback.length <= 220000) {
          resolve(fallback);
          return;
        }
        reject(new Error('Изображение слишком большое. Выберите другой файл.'));
      };
      img.src = String(reader.result || '');
    };
    reader.readAsDataURL(file);
  });
}
