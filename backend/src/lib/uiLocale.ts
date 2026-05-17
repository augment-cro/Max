import type { Request } from "express";

export type UiLocale = "en" | "hr";

export function parseUiLocale(req: Request): UiLocale {
    const raw = req.headers["x-ui-locale"];
    const v = Array.isArray(raw) ? raw[0] : raw;
    if (v === "hr" || v === "en") return v;
    return "en";
}

/**
 * Injected into LLM system prompts so outputs match the UI language and
 * regional standard (HR vs SR/BS; international EN vs colloquial AU), with
 * Europe/Zagreb as the primary clock for “today”.
 */
export function localeContextForLlm(locale: UiLocale): string {
    const now = new Date();
    const cet = new Intl.DateTimeFormat("en-GB", {
        timeZone: "Europe/Zagreb",
        weekday: "long",
        year: "numeric",
        month: "long",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
        second: "2-digit",
        hour12: false,
    }).format(now);

    if (locale === "hr") {
        return [
            "---",
            "JEZIK SUČELJA (obavezno): Korisnik koristi hrvatski (Hrvatska) u aplikaciji.",
            "Za sva polja koja korisnik vidi u sučelju (sažetak, obrazloženje/reasoning, oznake, naslove stupaca ako nisu citati iz dokumenta) piši isključivo standardnim hrvatskim: hrvatski pravopis i pravna terminologija.",
            "Izbjegavaj srpske, bosanske i crnogorske varijante (npr. izrazito srpske glagolske forme ili vokabular koji nije uobičajen u hrvatskom pravnom diskursu). Ako dokument sadrži drugi jezik, citiraj točno iz dokumenta, ali vlastiti sazdržaj formula na hrvatskom.",
            "Ne miješaj engleski u korisnički tekst osim citata iz dokumenta ili međunarodnih naziva kada je nužno.",
            `Referentno vrijeme (Europe/Zagreb, lokalno CET/CEST): ${cet}.`,
            "",
            "SADRŽAJ IZ ALATA (MCP konektori, web pretrage, baze zakona, sudska praksa):",
            "Kada alat vrati tekst na jeziku koji NIJE hrvatski (npr. engleski, talijanski, njemački, francuski, latinske sentencije, Akoma Ntoso XML…), preformuliraj ga i prevedi na hrvatski u svom odgovoru.",
            "Doslovne citate (kratki ulomci zakona, presuda, definicija) zadrži u izvornom jeziku unutar navodnika; objašnjenje, sažetak i analizu piši na hrvatskom.",
            "Ako tvoj konačni odgovor sadrži sadržaj koji potječe iz alata na jeziku različitom od hrvatskog, dodaj na samom kraju odgovora (nakon eventualnog <CITATIONS> bloka) jedan zaseban kurzivni redak oblika:",
            "  *Prevedeno s engleskog na hrvatski.*",
            "Ako su izvori bili na više jezika, navedi sve (npr. *Prevedeno s engleskog i talijanskog na hrvatski.*). Koristi hrvatske nazive jezika, abecednim redom.",
            "Ako su SVI alatni rezultati koje koristiš u odgovoru već na hrvatskom (ili nema poziva alata), NE dodaj tu napomenu.",
            "Ova napomena se odnosi na alate i konektore — NE na sadržaj korisnikovih učitanih dokumenata (za njih vrijedi pravilo o citatima na izvornom jeziku iz dijela DOCUMENT CITATION INSTRUCTIONS).",
            "---",
        ].join("\n");
    }

    return [
        "---",
        "UI LANGUAGE (required): The application UI is set to English.",
        "Write all user-visible extraction content (summary, reasoning, labels) in clear international English (UK/international professional style). Avoid Australian colloquialisms, British slang, or region-specific spelling unless the source document uses them in a quotation.",
        "When quoting the document, preserve the document’s language and wording.",
        `Reference date/time (Europe/Zagreb): ${cet}.`,
        "",
        "TOOL CONTENT (MCP connectors, web search, statute databases, case-law APIs):",
        "When a tool returns text in a language other than English (e.g. Croatian, Italian, German, French, Latin maxims, Akoma Ntoso XML…), translate it to English in your reply.",
        "Keep verbatim quotations (short passages of statutes, judgments, definitions) in their original language inside quotation marks; provide explanation, summary, and analysis in English.",
        "If your final reply contains content derived from non-English tool output, append a single italic line at the very end of the reply (after any <CITATIONS> block) in the form:",
        "  *Translated from Croatian to English.*",
        "If multiple source languages are present, list them all (e.g. *Translated from Croatian and Italian to English.*). Use English language names, in alphabetical order.",
        "If ALL tool results you use in your reply are already in English (or no tool was called), do NOT add this note.",
        "This rule applies to tools and connectors only — NOT to user-uploaded documents (those follow the verbatim-quote rule from DOCUMENT CITATION INSTRUCTIONS).",
        "---",
    ].join("\n");
}
