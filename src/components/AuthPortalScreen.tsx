import React, { useCallback, useEffect, useState } from 'react';
import {
  Delete,
  Eye,
  EyeOff,
  KeyRound,
  Lock,
  LogIn,
  ShieldCheck,
  Store,
  UserCheck,
} from 'lucide-react';
import { sha256Hex } from '../firebase';
import type { PosSecuritySettings } from '../types';

export const DEMO_ADMIN_LOGIN = 'admin';
export const DEMO_ADMIN_PASSWORD = 'admin123';
export const DEMO_CASHIER_PIN = '1234';

interface AuthPortalScreenProps {
  posSecurity: PosSecuritySettings | null;
  googleUserEmail?: string | null;
  googleAuthError?: string | null;
  onAdminLoginSuccess: (login: string, displayName: string) => void;
  onCashierPinSuccess: () => void;
  onGoogleSignIn: () => void;
}

type RoleMode = 'admin' | 'cashier';

export const AuthPortalScreen: React.FC<AuthPortalScreenProps> = ({
  posSecurity,
  googleUserEmail,
  googleAuthError,
  onAdminLoginSuccess,
  onCashierPinSuccess,
  onGoogleSignIn,
}) => {
  const [roleMode, setRoleMode] = useState<RoleMode>('admin');

  // Admin credentials state
  const [loginInput, setLoginInput] = useState('');
  const [passwordInput, setPasswordInput] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [adminError, setAdminError] = useState<string | null>(null);

  // Cashier PIN state
  const [pinDigits, setPinDigits] = useState('');
  const [pinError, setPinError] = useState<string | null>(null);
  const [verifyingPin, setVerifyingPin] = useState(false);

  const handleAdminSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setAdminError(null);
    const cleanLogin = loginInput.trim().toLowerCase();
    const cleanPass = passwordInput.trim();

    if (
      (cleanLogin === DEMO_ADMIN_LOGIN && cleanPass === DEMO_ADMIN_PASSWORD) ||
      (cleanLogin === 'owner' && cleanPass === 'admin123')
    ) {
      onAdminLoginSuccess(cleanLogin, cleanLogin === 'owner' ? 'Руководитель' : 'Администратор');
      return;
    }

    setAdminError('Неверный логин или пароль. Используйте тестовые данные: admin / admin123');
  };

  const verifyCashierPin = useCallback(
    async (candidate: string) => {
      if (candidate.length < 4 || verifyingPin) return;
      setVerifyingPin(true);
      setPinError(null);
      try {
        const enteredHash = await sha256Hex(candidate);
        const defaultHash = await sha256Hex(DEMO_CASHIER_PIN);
        const storedHash = posSecurity?.adminPinHash;

        if (enteredHash === defaultHash || (storedHash && enteredHash === storedHash)) {
          onCashierPinSuccess();
          return;
        }
        setPinError('Неверный PIN-код кассира. Попробуйте 1234.');
        setPinDigits('');
      } finally {
        setVerifyingPin(false);
      }
    },
    [onCashierPinSuccess, posSecurity?.adminPinHash, verifyingPin]
  );

  const appendPinDigit = useCallback(
    (digit: string) => {
      setPinError(null);
      setPinDigits((prev) => {
        if (prev.length >= 6) return prev;
        const next = prev + digit;
        if (next.length === 4) {
          void verifyCashierPin(next);
        }
        return next;
      });
    },
    [verifyCashierPin]
  );

  const handlePinBackspace = useCallback(() => {
    setPinError(null);
    setPinDigits((prev) => prev.slice(0, -1));
  }, []);

  const handlePinClear = useCallback(() => {
    setPinError(null);
    setPinDigits('');
  }, []);

  // Support physical keyboard input while Cashier PIN tab is active
  useEffect(() => {
    if (roleMode !== 'cashier') return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (/^[0-9]$/.test(e.key)) {
        e.preventDefault();
        appendPinDigit(e.key);
      } else if (e.key === 'Backspace') {
        e.preventDefault();
        handlePinBackspace();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        handlePinClear();
      } else if (e.key === 'Enter' && pinDigits.length >= 4) {
        e.preventDefault();
        void verifyCashierPin(pinDigits);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [roleMode, appendPinDigit, handlePinBackspace, handlePinClear, pinDigits, verifyCashierPin]);

  const pinLength = Math.max(4, pinDigits.length);

  return (
    <div className="min-h-screen bg-slate-100 flex items-center justify-center p-4 sm:p-8">
      <div className="w-full max-w-4xl bg-white border border-slate-200 rounded-2xl overflow-hidden grid grid-cols-1 lg:grid-cols-12">
        {/* Left Structural Panel: Brand & Role Selector */}
        <div className="lg:col-span-5 bg-slate-900 text-white p-6 sm:p-8 flex flex-col justify-between gap-8">
          <div className="space-y-6">
            <div>
              <div className="inline-flex items-center gap-2 text-emerald-400 text-xs font-semibold tracking-wide">
                <Store className="w-4 h-4" />
                <span>Авторизация персонала</span>
              </div>
              <h1 className="text-2xl sm:text-3xl font-bold tracking-tight text-white mt-2 text-balance">
                FreshMart Pro Imon
              </h1>
              <p className="text-sm text-slate-300 mt-2 leading-relaxed">
                Выберите роль для входа в систему управления магазином или на кассовый терминал.
              </p>
            </div>

            <div className="space-y-2.5">
              <button
                type="button"
                onClick={() => {
                  setRoleMode('admin');
                  setPinError(null);
                }}
                className={`w-full text-left p-4 rounded-xl border transition-colors ${
                  roleMode === 'admin'
                    ? 'bg-emerald-600 border-emerald-500 text-white'
                    : 'bg-slate-800/70 border-slate-700 text-slate-200 hover:bg-slate-800'
                }`}
              >
                <div className="flex items-center gap-2.5 text-sm font-semibold">
                  <ShieldCheck className="w-4 h-4 shrink-0" />
                  <span>Администратор / Руководитель</span>
                </div>
                <p
                  className={`text-xs mt-1 leading-relaxed ${
                    roleMode === 'admin' ? 'text-emerald-50' : 'text-slate-400'
                  }`}
                >
                  Полный портал: финансы (P&amp;L и ДДС), склад, закупки, заявки и онлайн-магазин.
                </p>
              </button>

              <button
                type="button"
                onClick={() => {
                  setRoleMode('cashier');
                  setAdminError(null);
                  setPinDigits('');
                  setPinError(null);
                }}
                className={`w-full text-left p-4 rounded-xl border transition-colors ${
                  roleMode === 'cashier'
                    ? 'bg-emerald-600 border-emerald-500 text-white'
                    : 'bg-slate-800/70 border-slate-700 text-slate-200 hover:bg-slate-800'
                }`}
              >
                <div className="flex items-center gap-2.5 text-sm font-semibold">
                  <KeyRound className="w-4 h-4 shrink-0" />
                  <span>Кассир</span>
                </div>
                <p
                  className={`text-xs mt-1 leading-relaxed ${
                    roleMode === 'cashier' ? 'text-emerald-50' : 'text-slate-400'
                  }`}
                >
                  Вход по цифровому PIN-коду. Открывает только полноэкранную «Кассу (POS)».
                </p>
              </button>
            </div>
          </div>

          {/* Cloud Database Connection Status */}
          <div className="pt-4 border-t border-slate-800 space-y-2">
            {googleUserEmail ? (
              <div className="text-xs text-slate-300 flex items-center gap-2">
                <UserCheck className="w-4 h-4 text-emerald-400 shrink-0" />
                <span className="truncate">Облако Firebase: {googleUserEmail}</span>
              </div>
            ) : (
              <div className="space-y-2">
                <p className="text-xs text-slate-400">
                  Для облачной синхронизации с базой Firestore можно также подключить Google-аккаунт:
                </p>
                <button
                  type="button"
                  onClick={onGoogleSignIn}
                  className="w-full inline-flex items-center justify-center gap-2 px-3.5 py-2 text-xs font-medium text-slate-200 bg-slate-800 border border-slate-700 rounded-lg hover:bg-slate-700 transition-colors whitespace-nowrap"
                >
                  <LogIn className="w-3.5 h-3.5" />
                  Подключить Google-аккаунт
                </button>
              </div>
            )}
            {googleAuthError && (
              <p className="text-xs text-red-300">{googleAuthError}</p>
            )}
          </div>
        </div>

        {/* Right Form Panel */}
        <div className="lg:col-span-7 p-6 sm:p-8 flex flex-col justify-center">
          {roleMode === 'admin' ? (
            <div className="space-y-6">
              <div>
                <h2 className="text-xl font-bold text-slate-900">
                  Вход для Администратора и Руководителя
                </h2>
                <p className="text-sm text-slate-500 mt-1">
                  Введите логин и пароль для доступа ко всем разделам и отчётам.
                </p>
              </div>

              <form onSubmit={handleAdminSubmit} className="space-y-4">
                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1.5">
                    Логин
                  </label>
                  <input
                    type="text"
                    autoFocus
                    required
                    value={loginInput}
                    onChange={(e) => {
                      setLoginInput(e.target.value);
                      setAdminError(null);
                    }}
                    placeholder="Введите логин"
                    className="w-full px-3.5 py-2.5 text-sm bg-slate-50 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-600 focus:bg-white"
                  />
                </div>

                <div>
                  <label className="block text-xs font-medium text-slate-700 mb-1.5">
                    Пароль
                  </label>
                  <div className="relative">
                    <input
                      type={showPassword ? 'text' : 'password'}
                      required
                      value={passwordInput}
                      onChange={(e) => {
                        setPasswordInput(e.target.value);
                        setAdminError(null);
                      }}
                      placeholder="Введите пароль"
                      className="w-full pl-3.5 pr-10 py-2.5 text-sm bg-slate-50 border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-600 focus:bg-white"
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword((v) => !v)}
                      aria-label={showPassword ? 'Скрыть пароль' : 'Показать пароль'}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-700"
                    >
                      {showPassword ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                  </div>
                </div>

                {adminError && (
                  <div className="px-3.5 py-2.5 text-xs text-red-800 bg-red-50 border border-red-200 rounded-lg">
                    {adminError}
                  </div>
                )}

                <button
                  type="submit"
                  className="w-full py-3 text-sm font-semibold text-white bg-slate-900 rounded-lg hover:bg-slate-800 transition-colors inline-flex items-center justify-center gap-2"
                >
                  <Lock className="w-4 h-4" />
                  Войти в рабочий портал
                </button>
              </form>

              {/* Visible Test Credentials Box */}
              <div className="p-4 rounded-xl bg-slate-50 border border-slate-200 flex flex-wrap items-center justify-between gap-3">
                <div className="space-y-0.5 text-xs">
                  <div className="font-semibold text-slate-800">
                    Тестовые данные для входа Администратора
                  </div>
                  <div className="text-slate-600 font-mono">
                    Логин: <strong className="text-slate-900">{DEMO_ADMIN_LOGIN}</strong> · Пароль:{' '}
                    <strong className="text-slate-900">{DEMO_ADMIN_PASSWORD}</strong>
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setLoginInput(DEMO_ADMIN_LOGIN);
                    setPasswordInput(DEMO_ADMIN_PASSWORD);
                    setAdminError(null);
                  }}
                  className="px-3 py-1.5 text-xs font-semibold text-emerald-800 bg-white border border-emerald-300 rounded-lg hover:bg-emerald-50 whitespace-nowrap shrink-0"
                >
                  Заполнить
                </button>
              </div>
            </div>
          ) : (
            <div className="space-y-5">
              <div className="text-center">
                <h2 className="text-xl font-bold text-slate-900">Вход кассира по PIN-коду</h2>
                <p className="text-xs text-slate-500 mt-1">
                  Откроется только полноэкранная касса (POS) без доступа к отчётам и складу.
                </p>
              </div>

              {/* Digital PIN Indicator */}
              <div className="flex items-center justify-center gap-3 py-2">
                {Array.from({ length: pinLength }).map((_, idx) => {
                  const filled = idx < pinDigits.length;
                  return (
                    <div
                      key={idx}
                      className={`w-12 h-12 rounded-xl border-2 flex items-center justify-center font-mono text-2xl font-bold transition-colors ${
                        filled
                          ? 'border-emerald-600 bg-emerald-50 text-emerald-700'
                          : 'border-slate-200 bg-slate-50 text-slate-300'
                      }`}
                    >
                      {filled ? '•' : ''}
                    </div>
                  );
                })}
              </div>

              {pinError && (
                <div className="px-3.5 py-2 text-xs text-center text-red-800 bg-red-50 border border-red-200 rounded-lg">
                  {pinError}
                </div>
              )}

              {/* On-Screen Numeric Keypad */}
              <div className="grid grid-cols-3 gap-2.5 max-w-xs mx-auto">
                {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((digit) => (
                  <button
                    key={digit}
                    type="button"
                    disabled={verifyingPin}
                    onClick={() => appendPinDigit(digit)}
                    className="h-14 rounded-xl border border-slate-200 bg-slate-50 hover:bg-slate-100 active:bg-emerald-50 active:border-emerald-400 font-mono text-xl font-semibold text-slate-900 transition-colors"
                  >
                    {digit}
                  </button>
                ))}
                <button
                  type="button"
                  disabled={verifyingPin}
                  onClick={handlePinClear}
                  className="h-14 rounded-xl border border-slate-200 bg-white hover:bg-slate-100 text-xs font-semibold text-slate-600 transition-colors"
                >
                  Очистить
                </button>
                <button
                  type="button"
                  disabled={verifyingPin}
                  onClick={() => appendPinDigit('0')}
                  className="h-14 rounded-xl border border-slate-200 bg-slate-50 hover:bg-slate-100 active:bg-emerald-50 active:border-emerald-400 font-mono text-xl font-semibold text-slate-900 transition-colors"
                >
                  0
                </button>
                <button
                  type="button"
                  disabled={verifyingPin}
                  onClick={handlePinBackspace}
                  aria-label="Удалить последнюю цифру"
                  className="h-14 rounded-xl border border-slate-200 bg-white hover:bg-slate-100 flex items-center justify-center text-slate-600 transition-colors"
                >
                  <Delete className="w-5 h-5" />
                </button>
              </div>

              <div className="max-w-xs mx-auto space-y-3">
                <button
                  type="button"
                  disabled={pinDigits.length < 4 || verifyingPin}
                  onClick={() => void verifyCashierPin(pinDigits)}
                  className="w-full py-3 text-sm font-semibold text-white bg-emerald-600 rounded-lg hover:bg-emerald-700 disabled:opacity-40 transition-colors"
                >
                  {verifyingPin ? 'Проверка PIN...' : 'Открыть кассу (POS)'}
                </button>

                <div className="text-center text-xs text-slate-500">
                  Тестовый PIN-код кассира:{' '}
                  <span className="font-mono font-bold text-slate-900">{DEMO_CASHIER_PIN}</span>
                </div>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
