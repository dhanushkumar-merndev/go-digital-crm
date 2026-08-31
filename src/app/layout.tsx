import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import { AppProviders } from '@/components/providers/app-providers';
import { RoleSwitcher } from '@/components/shared/role-switcher';
import { PersistentAuthLottie } from '@/features/auth/persistent-auth-lottie';
import { isDevelopmentDemoRoleLoginEnabled, isLocalPreviewMode } from '@/lib/runtime/runtime-mode';
import './globals.css';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter' });

export const metadata: Metadata = {
  title: { default: 'Go Digital Marketing CRM', template: '%s · Go Digital Marketing CRM' },
  description: 'Multi-tenant automobile dealership CRM',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  const previewMode = isLocalPreviewMode();
  const demoRoleLoginEnabled = isDevelopmentDemoRoleLoginEnabled();
  return (
    <html lang="en">
      <body className={`${inter.variable} min-h-screen antialiased`}>
        <AppProviders>
          {children}
          <PersistentAuthLottie />
          {previewMode ? <RoleSwitcher /> : null}
          {!previewMode && demoRoleLoginEnabled ? <RoleSwitcher mode="demo-login" /> : null}
        </AppProviders>
      </body>
    </html>
  );
}
