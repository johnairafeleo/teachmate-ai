import { CtaSection } from "@/components/marketing/cta-section";
import { Features } from "@/components/marketing/features";
import { GenerationModes } from "@/components/marketing/generation-modes";
import { Hero } from "@/components/marketing/hero";
import { SiteFooter } from "@/components/marketing/site-footer";
import { SiteHeader } from "@/components/marketing/site-header";

export default function LandingPage() {
  return (
    <>
      <SiteHeader />
      <main id="main-content" tabIndex={-1} className="flex-1">
        <Hero />
        <GenerationModes />
        <Features />
        <CtaSection />
      </main>
      <SiteFooter />
    </>
  );
}
