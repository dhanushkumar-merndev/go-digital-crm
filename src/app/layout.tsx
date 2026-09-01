import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import { AppProviders } from '@/components/providers/app-providers';
import { RoleSwitcher } from '@/components/shared/role-switcher';
import { ViewportScale } from '@/components/shared/viewport-scale';
import { PersistentAuthLottie } from '@/features/auth/persistent-auth-lottie';
import { isDevelopmentDemoRoleLoginEnabled, isLocalPreviewMode } from '@/lib/runtime/runtime-mode';
import { VIEWPORT_ZOOM_SCRIPT } from '@/lib/layout/viewport-scale';
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
    // The pre-paint script below writes `style="zoom"` onto this element
    // before React hydrates, so the root's attributes will not match the
    // server HTML. That is the point of running it early, not a defect.
    <html lang="en" suppressHydrationWarning>
      <head>
        {/* Sizes the 1920 design canvas before first paint, so a wide monitor
            never shows one unscaled frame. */}
        <script dangerouslySetInnerHTML={{ __html: VIEWPORT_ZOOM_SCRIPT }} />
      </head>
      <body className={`${inter.variable} min-h-screen antialiased`}>
        <ViewportScale />
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
