import type { Metadata } from "next";
import { headers } from "next/headers";
import "./globals.css";

const description =
  "Build applications and agents on real physical phones. Assigned device access through the browser, REST API, and MCP.";

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const forwardedHost = requestHeaders.get("x-forwarded-host")?.split(",")[0]?.trim();
  const requestHost = forwardedHost ?? requestHeaders.get("host") ?? "127.0.0.1:3020";
  const safeHost = /^[a-zA-Z0-9.:[\]-]+$/.test(requestHost)
    ? requestHost
    : "127.0.0.1:3020";
  const forwardedProtocol = requestHeaders.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const protocol = forwardedProtocol === "https" ? "https" : "http";
  const imageUrl = `${protocol}://${safeHost}/og.png`;
  const hostname = safeHost.startsWith("[")
    ? safeHost.slice(0, safeHost.indexOf("]") + 1)
    : safeHost.split(":")[0];
  const isLocal = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]).has(hostname);
  return {
    title: isLocal ? "PhoneUse · Device Platform" : "PhoneUse | Your software. The real world.",
    description,
    icons: { icon: "/favicon.svg" },
    openGraph: {
      title: "PhoneUse | Your software. The real world.",
      description,
      type: "website",
      images: [{ url: imageUrl, width: 1734, height: 907, alt: "PhoneUse — conceptual illustration of physical device control" }],
    },
    twitter: {
      card: "summary_large_image",
      title: "PhoneUse | Your software. The real world.",
      description,
      images: [imageUrl],
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
