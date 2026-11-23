"use client";

import "./globals.css";

// Replaces the root layout when the layout itself fails, so there is no translation provider:
// the copy is the default language (Indonesian). It shows nothing of the error.
export default function GlobalError({
  retry,
}: {
  error: unknown;
  retry: () => void;
  reset?: () => void;
}) {
  return (
    <html lang="id" className="h-full antialiased">
      <body className="flex min-h-full flex-col items-center justify-center gap-4 bg-background p-6">
        <main className="flex w-full max-w-md flex-col gap-4 rounded-xl border bg-card p-6 shadow-card">
          <h1 className="font-heading text-2xl font-bold">Terjadi kesalahan</h1>
          <p className="text-muted-foreground">
            Halaman ini tidak bisa ditampilkan. Coba lagi; jika masih gagal, muat ulang
            halaman atau kembali lagi nanti.
          </p>
          <button
            type="button"
            onClick={() => {
              retry();
            }}
            className="inline-flex min-h-12 items-center justify-center self-start rounded-lg bg-primary px-6 font-heading text-base font-semibold text-primary-foreground"
          >
            Coba lagi
          </button>
        </main>
      </body>
    </html>
  );
}
