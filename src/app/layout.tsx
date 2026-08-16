import type { Metadata } from 'next';
import { Inter } from 'next/font/google';
import { AppProviders } from '@/components/providers/app-providers';
import { PersistentAuthLottie } from '@/features/auth/persistent-auth-lottie';
import './globals.css';

const inter = Inter({ subsets: ['latin'], variable: '--font-inter' });

export const metadata: Metadata = {
  title: { default: 'Go Digital Marketing CRM', template: '%s · Go Digital Marketing CRM' },
  description: 'Multi-tenant automobile dealership CRM',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className={`${inter.variable} min-h-screen antialiased`}>
        <AppProviders>
          {children}
          <PersistentAuthLottie />
        </AppProviders>
      </body>
    </html>
  );
}
