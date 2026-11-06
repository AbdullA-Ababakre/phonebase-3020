import type { Metadata } from "next";
import { notFound } from "next/navigation";
import pages from "../../../content/docs/pages.json";
import { DocsContent } from "../docs-content";
export function generateStaticParams() {
  return pages.map((page) => ({ slug: page.slug }));
}
export async function generateMetadata({
  params,
}: {
  params: Promise<{ slug: string }>;
}): Promise<Metadata> {
  const { slug } = await params;
  const page = pages.find((p) => p.slug === slug);
  return {
    title: page
      ? `${page.title} | PhoneUse Docs`
      : "Page not found | PhoneUse",
    description: page?.description,
  };
}
export default async function DocumentationPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  if (!pages.some((page) => page.slug === slug)) notFound();
  return <DocsContent slug={slug} />;
}
