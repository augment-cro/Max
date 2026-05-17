"use client";

import { useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import {
    ArrowRight,
    MessageSquareQuote,
    FolderOpen,
    Table2,
    Sparkles,
    KeyRound,
    ShieldCheck,
    Plug,
    Languages,
    Quote,
} from "lucide-react";
import { SiteLogo } from "@/components/site-logo";
import { MikeIcon } from "@/components/chat/mike-icon";
import { useAuth } from "@/contexts/AuthContext";
import { TokenBanner } from "@/app/components/landing/TokenBanner";
import { startAuthorizationFlow } from "@/lib/oauth";

const FEATURE_ICONS = {
    assistant: MessageSquareQuote,
    projects: FolderOpen,
    tabular: Table2,
    workflows: Sparkles,
} as const;

const WHY_ICONS = {
    byok: KeyRound,
    eulex: ShieldCheck,
    integrations: Plug,
    bilingual: Languages,
} as const;

export default function LandingPage() {
    const t = useTranslations("landing");
    const { isAuthenticated } = useAuth();
    const [oauthLoading, setOauthLoading] = useState(false);

    const primaryCtaLabel = isAuthenticated
        ? t("nav.openApp")
        : t("hero.primaryCta");

    // Start the EULEX OAuth (PKCE) round-trip directly so an unauthenticated
    // user clicking any CTA on the landing page is sent to eulex.ai right
    // away — no detour through /login. Authenticated users are routed to the
    // app via plain <Link> elements below.
    const handleEulexLogin = async () => {
        if (oauthLoading) return;
        setOauthLoading(true);
        try {
            const url = await startAuthorizationFlow();
            window.location.href = url;
        } catch {
            // Fall back to /login (which surfaces a proper error) on the
            // off-chance crypto.subtle / network setup fails.
            setOauthLoading(false);
            window.location.href = "/login";
        }
    };

    return (
        <div className="min-h-dvh bg-[#fafaf7] text-neutral-900">

            {/* ─── Top nav ─────────────────────────────────────────── */}
            <header className="sticky top-0 z-30 backdrop-blur-md bg-[#fafaf7]/85 border-b border-neutral-200/70">
                <div className="max-w-6xl mx-auto px-6 h-18 flex items-center justify-between">
                    {/* Bigger logo — md size in the nav */}
                    <SiteLogo size="md" />
                    <nav className="flex items-center gap-2 text-sm font-mono">
                        {isAuthenticated ? (
                            <Link
                                href="/assistant"
                                className="px-4 py-2 rounded-full bg-neutral-900 text-white hover:bg-neutral-800 transition-colors"
                            >
                                {t("nav.openApp")}
                            </Link>
                        ) : (
                            <button
                                onClick={handleEulexLogin}
                                disabled={oauthLoading}
                                className="px-4 py-2 rounded-full bg-neutral-900 text-white hover:bg-neutral-800 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
                            >
                                {t("nav.signInWithEulex")}
                            </button>
                        )}
                    </nav>
                </div>
            </header>

            {/* ─── Token banner ───────────────────────────────────── */}
            <TokenBanner />

            {/* ─── Hero ────────────────────────────────────────────── */}
            <section className="max-w-5xl mx-auto px-6 pt-20 md:pt-32 pb-16 md:pb-24 text-center">
                <p className="font-mono text-xs uppercase tracking-[0.2em] text-neutral-400 mb-8">
                    {t("hero.eyebrow")}
                </p>

                {/* Big serif headline */}
                <h1 className="font-serif text-5xl md:text-[5.5rem] leading-[1.0] tracking-tight text-neutral-900 whitespace-pre-line">
                    {t("hero.title")}
                </h1>

                {/* Punchy tagline underneath */}
                <p className="mt-5 font-serif text-2xl md:text-3xl text-neutral-500 italic">
                    {t("hero.tagline")}
                </p>

                <p className="mt-8 max-w-2xl mx-auto text-lg text-neutral-600 leading-relaxed">
                    {t("hero.subtitle")}
                </p>

                <div className="mt-10 flex flex-wrap items-center justify-center gap-3">
                    {isAuthenticated ? (
                        <Link
                            href="/assistant"
                            className="inline-flex items-center gap-2 px-6 py-3 rounded-full bg-neutral-900 text-white font-mono text-sm hover:bg-neutral-800 transition-colors"
                        >
                            {primaryCtaLabel}
                            <ArrowRight className="w-4 h-4" />
                        </Link>
                    ) : (
                        <button
                            onClick={handleEulexLogin}
                            disabled={oauthLoading}
                            className="inline-flex items-center gap-2 px-6 py-3 rounded-full bg-neutral-900 text-white font-mono text-sm hover:bg-neutral-800 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
                        >
                            {primaryCtaLabel}
                            <ArrowRight className="w-4 h-4" />
                        </button>
                    )}
                    <a
                        href="#features"
                        className="inline-flex items-center gap-2 px-6 py-3 rounded-full border border-neutral-300 text-neutral-700 font-mono text-sm hover:border-neutral-900 hover:bg-white transition-colors"
                    >
                        {t("hero.secondaryCta")}
                    </a>
                </div>

                {/* Hero visual — faux UI card */}
                <div className="mt-20 md:mt-24 relative max-w-3xl mx-auto">
                    <div className="absolute -top-12 left-1/2 -translate-x-1/2 z-10">
                        <div className="w-24 h-24 md:w-28 md:h-28 rounded-full bg-white border border-neutral-200 shadow-sm flex items-center justify-center">
                            <MikeIcon size={64} intro={false} />
                        </div>
                    </div>
                    <div className="rounded-2xl border border-neutral-200 bg-white shadow-[0_24px_60px_-24px_rgba(0,0,0,0.18)] overflow-hidden">
                        {/* Window chrome */}
                        <div className="flex items-center gap-1.5 px-4 py-3 border-b border-neutral-100">
                            <span className="w-2.5 h-2.5 rounded-full bg-neutral-200" />
                            <span className="w-2.5 h-2.5 rounded-full bg-neutral-200" />
                            <span className="w-2.5 h-2.5 rounded-full bg-neutral-200" />
                        </div>
                        <div className="grid grid-cols-1 md:grid-cols-5 gap-0">
                            {/* Chat side */}
                            <div className="md:col-span-3 p-6 md:p-8 border-b md:border-b-0 md:border-r border-neutral-100 text-left space-y-4">
                                <div className="rounded-xl bg-neutral-50 px-4 py-3 text-sm text-neutral-700 leading-relaxed font-serif">
                                    Sažmi obveze najmoprimca iz ugovora i citiraj članke.
                                </div>
                                <div className="text-sm text-neutral-800 leading-relaxed font-serif">
                                    Najmoprimac je dužan plaćati najamninu mjesečno do petog dana u mjesecu i održavati prostor u funkcionalnom stanju.
                                    <span className="inline-flex items-center gap-1 ml-1.5 px-1.5 py-0.5 rounded bg-blue-50 text-blue-700 text-[11px] font-mono align-middle">
                                        <Quote className="w-2.5 h-2.5" /> čl. 4.2
                                    </span>
                                </div>
                                <div className="h-px bg-neutral-100" />
                                <div className="text-xs font-mono text-neutral-400">
                                    citirano iz: ugovor-o-najmu.pdf · str. 3
                                </div>
                            </div>
                            {/* Document side */}
                            <div className="md:col-span-2 p-6 md:p-8 bg-neutral-50/60 text-left space-y-2">
                                <div className="text-[11px] font-mono uppercase tracking-wider text-neutral-400 mb-3">
                                    ugovor-o-najmu.pdf
                                </div>
                                <div className="space-y-1.5 text-[11px] text-neutral-500 leading-relaxed font-serif">
                                    <div>4.1 Trajanje najma je 24 mjeseca…</div>
                                    <div className="bg-yellow-100/70 rounded px-1 -mx-1 py-0.5 text-neutral-800">
                                        4.2 Najmoprimac plaća najamninu do 5. u mjesecu i održava prostor u funkcionalnom stanju.
                                    </div>
                                    <div>4.3 Otkazni rok iznosi tri mjeseca…</div>
                                </div>
                            </div>
                        </div>
                    </div>
                    <p className="mt-4 text-center text-xs font-mono text-neutral-400">
                        {t("hero.imageCaption")}
                    </p>
                </div>
            </section>

            {/* ─── Demo / quote band ───────────────────────────────── */}
            <section className="border-y border-neutral-200 bg-white">
                <div className="max-w-5xl mx-auto px-6 py-16 md:py-20 text-center">
                    <p className="font-mono text-xs uppercase tracking-[0.2em] text-neutral-400 mb-6">
                        {t("demo.eyebrow")}
                    </p>
                    <h2 className="font-serif text-3xl md:text-5xl leading-tight text-neutral-900 whitespace-pre-line">
                        {t("demo.title")}
                    </h2>
                    <p className="mt-6 max-w-2xl mx-auto text-base md:text-lg text-neutral-600 leading-relaxed">
                        {t("demo.description")}
                    </p>
                </div>
            </section>

            {/* ─── Features ───────────────────────────────────────── */}
            <section id="features" className="max-w-6xl mx-auto px-6 py-24 md:py-32">
                <h2 className="font-serif text-3xl md:text-5xl leading-tight text-neutral-900 max-w-3xl whitespace-pre-line">
                    {t("features.title")}
                </h2>
                <p className="mt-4 font-mono text-sm text-neutral-400">
                    {t("features.subtitle")}
                </p>

                <div className="mt-16 grid grid-cols-1 md:grid-cols-2 gap-8 md:gap-10">
                    {(["assistant", "projects", "tabular", "workflows"] as const).map((key) => {
                        const Icon = FEATURE_ICONS[key];
                        return (
                            <article
                                key={key}
                                className="group rounded-2xl border border-neutral-200 bg-white p-8 md:p-10 hover:border-neutral-900/40 hover:shadow-[0_24px_60px_-32px_rgba(0,0,0,0.2)] transition-all"
                            >
                                <div className="w-11 h-11 rounded-xl bg-neutral-900 text-white flex items-center justify-center">
                                    <Icon className="w-5 h-5" strokeWidth={1.6} />
                                </div>
                                <h3 className="mt-6 font-serif text-2xl md:text-3xl text-neutral-900">
                                    {t(`features.${key}.title`)}
                                </h3>
                                <p className="mt-3 text-[15px] leading-relaxed text-neutral-600">
                                    {t(`features.${key}.description`)}
                                </p>
                            </article>
                        );
                    })}
                </div>
            </section>

            {/* ─── Why Max ────────────────────────────────────────── */}
            <section className="bg-neutral-900 text-neutral-100">
                <div className="max-w-6xl mx-auto px-6 py-24 md:py-32">
                    <h2 className="font-serif text-3xl md:text-5xl leading-tight max-w-3xl whitespace-pre-line">
                        {t("why.title")}
                    </h2>
                    <div className="mt-16 grid grid-cols-1 md:grid-cols-2 gap-x-12 gap-y-12">
                        {(["byok", "eulex", "integrations", "bilingual"] as const).map((key) => {
                            const Icon = WHY_ICONS[key];
                            return (
                                <div key={key} className="flex gap-5">
                                    <div className="shrink-0 w-10 h-10 rounded-lg border border-neutral-700 flex items-center justify-center">
                                        <Icon className="w-4 h-4 text-neutral-300" strokeWidth={1.6} />
                                    </div>
                                    <div>
                                        <h3 className="font-serif text-xl md:text-2xl text-white">
                                            {t(`why.items.${key}.title`)}
                                        </h3>
                                        <p className="mt-2 text-[15px] leading-relaxed text-neutral-400">
                                            {t(`why.items.${key}.description`)}
                                        </p>
                                    </div>
                                </div>
                            );
                        })}
                    </div>
                </div>
            </section>

            {/* ─── Final CTA ──────────────────────────────────────── */}
            <section className="max-w-4xl mx-auto px-6 py-24 md:py-32 text-center">
                <h2 className="font-serif text-4xl md:text-6xl leading-[1.05] text-neutral-900">
                    {t("cta.title")}
                </h2>
                <p className="mt-6 max-w-xl mx-auto text-base md:text-lg text-neutral-600 leading-relaxed">
                    {t("cta.subtitle")}
                </p>
                <div className="mt-10 flex flex-wrap items-center justify-center gap-3">
                    {isAuthenticated ? (
                        <Link
                            href="/assistant"
                            className="inline-flex items-center gap-2 px-6 py-3 rounded-full bg-neutral-900 text-white font-mono text-sm hover:bg-neutral-800 transition-colors"
                        >
                            {t("nav.openApp")}
                            <ArrowRight className="w-4 h-4" />
                        </Link>
                    ) : (
                        <button
                            onClick={handleEulexLogin}
                            disabled={oauthLoading}
                            className="inline-flex items-center gap-2 px-6 py-3 rounded-full bg-neutral-900 text-white font-mono text-sm hover:bg-neutral-800 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
                        >
                            {t("cta.primary")}
                            <ArrowRight className="w-4 h-4" />
                        </button>
                    )}
                </div>
            </section>

            {/* ─── Footer ─────────────────────────────────────────── */}
            <footer className="border-t border-neutral-200 bg-[#fafaf7]">
                <div className="max-w-6xl mx-auto px-6 py-10 flex flex-col md:flex-row items-center justify-between gap-6">
                    <SiteLogo size="sm" />
                    <a
                        href="https://eulex.ai"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="hover:opacity-80 transition-opacity"
                        aria-label="EULEX"
                    >
                        <img
                            src="/eulex-logo.png"
                            alt="EULEX"
                            className="h-8 w-auto"
                        />
                    </a>
                    <p className="text-neutral-400 text-sm font-mono">
                        {t("footer.tagline")}
                    </p>
                    <div className="flex items-center gap-5 font-mono text-xs text-neutral-400">
                        <a
                            href="https://eulex.ai"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="inline-flex items-center gap-1.5 hover:text-neutral-900 transition-colors"
                        >
                            <svg viewBox="0 0 24 24" className="w-3.5 h-3.5 fill-current" aria-hidden>
                                <path d="M12 0C5.37 0 0 5.37 0 12c0 5.3 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61-.546-1.385-1.335-1.755-1.335-1.755-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 21.795 24 17.295 24 12c0-6.63-5.37-12-12-12" />
                            </svg>
                            GitHub
                        </a>
                        <a href="https://eulex.ai/privacy" target="_blank" rel="noopener noreferrer" className="hover:text-neutral-900 transition-colors">
                            {t("footer.privacy")}
                        </a>
                        <a href="https://eulex.ai/terms" target="_blank" rel="noopener noreferrer" className="hover:text-neutral-900 transition-colors">
                            {t("footer.terms")}
                        </a>
                        <a href="mailto:info@eulex.ai" className="hover:text-neutral-900 transition-colors">
                            {t("footer.contact")}
                        </a>
                    </div>
                </div>
            </footer>
        </div>
    );
}
