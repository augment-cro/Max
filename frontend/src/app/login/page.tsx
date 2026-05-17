"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useTranslations } from "next-intl";
import { ArrowRight } from "lucide-react";
import { SiteLogo } from "@/components/site-logo";
import { useAuth } from "@/contexts/AuthContext";
import {
    startAuthorizationFlow,
    stashPostLoginRedirect,
    consumePostLoginRedirect,
} from "@/lib/oauth";

export default function LoginPage() {
    const router = useRouter();
    const { isAuthenticated, authLoading } = useAuth();
    const t = useTranslations("login");
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const autoLoginTriggered = useRef(false);

    // Stash the deep-link target as early as possible — the OAuth round
    // trip will wipe the URL by the time we land back here. Same-origin
    // whitelist enforced inside `stashPostLoginRedirect`.
    useEffect(() => {
        if (typeof window === "undefined") return;
        const params = new URLSearchParams(window.location.search);
        const raw = params.get("next") ?? params.get("redirect");
        if (raw) stashPostLoginRedirect(raw);
    }, []);

    useEffect(() => {
        if (!authLoading && isAuthenticated) {
            const next = consumePostLoginRedirect();
            router.replace(next ?? "/assistant");
        }
    }, [authLoading, isAuthenticated, router]);

    // Backwards-compat: WordPress may still bounce users back here with
    // ?social_done=1 from earlier sessions. Honor that flag and auto-start
    // the PKCE round-trip so the user lands inside the app without a click.
    useEffect(() => {
        if (typeof window === "undefined") return;
        const params = new URLSearchParams(window.location.search);
        if (params.get("social_done") !== "1") return;
        if (autoLoginTriggered.current) return;
        autoLoginTriggered.current = true;
        setLoading(true);
        setError(null);
        startAuthorizationFlow()
            .then((url) => { window.location.href = url; })
            .catch((err: any) => {
                setError(err.message || "Failed to start login flow");
                setLoading(false);
            });
    }, []);

    const handleLogin = async () => {
        setLoading(true);
        setError(null);
        try {
            const url = await startAuthorizationFlow();
            window.location.href = url;
        } catch (err: any) {
            setError(err.message || "Failed to start login flow");
            setLoading(false);
        }
    };

    return (
        <div className="min-h-dvh bg-white flex items-start justify-center px-6 pt-32 md:pt-40 pb-10 relative">
            <div className="absolute top-4 md:top-8 left-1/2 -translate-x-1/2">
                <SiteLogo size="md" className="md:text-4xl" asLink />
            </div>
            <div className="w-full max-w-md">
                {/* Login Card */}
                <div className="bg-white border border-gray-200 rounded-2xl p-8">
                    <div className="flex justify-between items-center mb-6">
                        <h2 className="text-left text-2xl font-serif">
                            {t("title")}
                        </h2>
                        <div className="bg-gray-100 p-1 rounded-md flex text-xs font-medium">
                            <span className="text-gray-600 px-3 py-1 bg-white rounded-sm shadow-sm">
                                {t("logIn")}
                            </span>
                            <a
                                href="https://eulex.ai/signup"
                                target="_blank"
                                rel="noopener noreferrer"
                                className="px-3 py-1 text-gray-500 hover:text-gray-900"
                            >
                                {t("signUp")}
                            </a>
                        </div>
                    </div>

                    {/* Primary OAuth Login */}
                    <button
                        onClick={handleLogin}
                        disabled={loading}
                        className="w-full inline-flex items-center justify-center gap-2 px-6 py-3 rounded-full bg-neutral-900 text-white font-mono text-sm hover:bg-neutral-800 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
                    >
                        {loading ? (
                            <span className="flex items-center gap-2">
                                <span className="animate-spin rounded-full h-4 w-4 border-2 border-white border-t-transparent" />
                                {t("redirecting")}
                            </span>
                        ) : (
                            <>
                                {t("signInWithEulex")}
                                <ArrowRight className="w-4 h-4" />
                            </>
                        )}
                    </button>

                    <p className="mt-5 text-center text-[11px] leading-relaxed text-gray-500">
                        {t.rich("legalNotice", {
                            terms: (chunks) => (
                                <a
                                    href="https://eulex.ai/terms"
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-blue-600 hover:underline"
                                >
                                    {chunks}
                                </a>
                            ),
                            privacy: (chunks) => (
                                <a
                                    href="https://eulex.ai/privacy"
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="text-blue-600 hover:underline"
                                >
                                    {chunks}
                                </a>
                            ),
                        })}
                    </p>

                    {error && (
                        <div className="mt-4 text-red-600 text-sm bg-red-50 p-3 rounded">
                            {error}
                        </div>
                    )}

                    {/* Info text */}
                    <p className="mt-5 text-center text-xs text-gray-400">
                        {t("noAccount")}{" "}
                        <a
                            href="https://eulex.ai/signup"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-blue-600 hover:underline"
                        >
                            {t("createAccount")}
                        </a>
                    </p>
                </div>
            </div>
        </div>
    );
}
