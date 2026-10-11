import { ArrowUpRight, Download } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SITE_LINKS } from "@/lib/site-links";

export function SiteQrCodes() {
  return (
    <section className="site-qr" aria-label="PetroGrid QR codes">
      {SITE_LINKS.map((site) => (
        <div className="site-qr-item" key={site.file}>
          <img src={`/qr/${site.file}.svg`} width="180" height="180" alt={`QR code for ${site.domain}`} />
          <div className="site-qr-info">
            <h2>{site.name}</h2>
            <Button asChild variant="link" className="site-qr-link">
              <a href={site.url} target="_blank" rel="noreferrer">{site.domain}<ArrowUpRight /></a>
            </Button>
            <Button asChild variant="outline" size="sm">
              <a href={`/qr/${site.file}.png`} download={`${site.file}-qr.png`}><Download />Download QR</a>
            </Button>
          </div>
        </div>
      ))}
    </section>
  );
}