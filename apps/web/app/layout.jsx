export const metadata = {
  title: 'Proposal Generator',
  description: 'Generate WPPRO search proposals from a frozen layout.',
};

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
