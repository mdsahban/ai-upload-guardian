import React from "react";
import { Link } from "react-router-dom";

const features = [
  {
    title: "Upload & chat review",
    body: "See every risky upload and chat paste in one queue. Approve, block, or send to AutoFix with full context."
  },
  {
    title: "AutoFix workflow",
    body: "Request sanitization, track completion, and export outcomes without exposing raw PII in the UI."
  },
  {
    title: "Organizations & invites",
    body: "Multi-tenant orgs, invite codes, and user lifecycle controls so pilots scale cleanly."
  },
  {
    title: "Audit & exports",
    body: "Immutable audit trail plus CSV exports for compliance reviews and incident response."
  }
];

export function LandingPage() {
  return (
    <div className="landingPage">
      <header className="landingTop">
        <div className="landingBrand">
          <div className="landingBrandTitle">AI Upload Guardian</div>
          <div className="landingBrandSub">Policy layer for AI tools and uploads</div>
        </div>
        <nav className="landingNav">
          <Link className="landingSignInNav" to="/login">
            Admin sign in
          </Link>
        </nav>
      </header>

      <main className="landingMain">
        <section className="landingHero">
          <h1 className="landingHeroTitle">Guard uploads before they reach the model</h1>
          <p className="landingHeroLead">
            A browser extension plus admin console for scanning files and chat input, scoring risk, and
            enforcing review — without slowing down your team.
          </p>
          <div className="landingHeroActions">
            <Link className="landingCtaPrimary" to="/login">
              Open admin console
            </Link>
            <span className="landingHeroHint">
              Sign in with your developer-provisioned panel account.
            </span>
          </div>
        </section>

        <section className="landingFeatures">
          <h2 className="landingSectionTitle">What you get</h2>
          <div className="landingGrid">
            {features.map((f) => (
              <article key={f.title} className="landingCard">
                <h3 className="landingCardTitle">{f.title}</h3>
                <p className="landingCardBody">{f.body}</p>
              </article>
            ))}
          </div>
        </section>
      </main>

      <footer className="landingFooter">
        <span>AI Upload Guardian — admin tools for operators and security teams.</span>
      </footer>
    </div>
  );
}
