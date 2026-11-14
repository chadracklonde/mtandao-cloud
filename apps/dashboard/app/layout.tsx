import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Mtandao Cloud',
  description: 'Gestion centralisée des sites Wi-Fi Mtandao',
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="fr"><body>{children}</body></html>;
}
