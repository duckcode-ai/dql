# DQL OSS Promotion Plan — Pre-Cloud Launch

**Goal:** Build awareness, GitHub stars, and early adopters before the hosted cloud release.  
**Target:** Analytics engineers and data teams already using dbt, DuckDB, or BI tools like Looker/Metabase.

---

## 1. Your Core Message (Lead With This Everywhere)

> **"DQL is a local-first, git-native analytics workspace for dbt teams. Every query, dashboard, AI answer, and certification status lives in a `.dql` file you can commit, review, and trust."**

The single problem you solve: **query sprawl + broken charts + ungoverned AI answers**.  
The single counter-position: Looker/Metabase are cloud-first, black-box, and don't speak dbt. DQL is the governed analytics layer that sits between dbt and your BI tool — locally.

---

## 2. Target Audiences (Priority Order)

| # | Audience | Why They Care |
|---|----------|---------------|
| 1 | **dbt users** (analytics engineers) | DQL is non-destructive on top of dbt — zero migration risk |
| 2 | **DuckDB power users** | Local-first, DuckDB native, zero setup |
| 3 | **Teams leaving Looker/Metabase** | Migration guides already exist in your docs |
| 4 | **AI/data teams** | Governed AI answers with certified block retrieval |
| 5 | **Platform/data engineers** | OpenLineage export, CLI-first, git-native |

---

## 3. Channels + What to Post (Ranked by ROI)

### 🥇 Tier 1 — Highest Signal, Must Do

#### A. dbt Slack (`#tools-and-integrations`)
**What:** Short intro post, link to Jaffle Shop demo, Docker one-liner.  
**Tone:** Peer-to-peer, not marketing. Lead with the dbt integration story.  
**Template:**
```
Hey dbt Slack 👋 Built something that sits on top of your dbt project without 
touching it: DQL — git-native certified blocks, lineage, and governed AI answers.

Run the Jaffle Shop demo in 2 minutes:
  git clone https://github.com/duckcode-ai/dql && cd dql && docker compose up

Curious what people think about the certified block model vs. Exposure + test approach in dbt.
```
**When:** Tuesday or Wednesday 10am–noon US Eastern.

#### B. Hacker News — Show HN
**Title:** `Show HN: DQL – local-first certified analytics blocks for dbt teams`  
**What goes in the text:**
- One sentence: what it is
- One sentence: the problem (query sprawl, broken dashboards)
- The 2-minute Docker demo command
- Link to Acme Bank GIF walkthrough
- One honest limitation ("single-user OSS; multi-user cloud is on the roadmap")

**When:** Tuesday–Thursday 8–9am US Eastern for best visibility.  
**Critical:** Be online to reply for 2 hours after posting. HN rewards engagement.

#### C. Reddit — r/dataengineering
**Title:** `I built an open-source governed analytics layer for dbt — certified blocks, lineage, and local AI answers`  
**Format:** Long-form post walking through the "why" (query sprawl problem) → the solution → Docker demo → link to GitHub.  
**When:** Tuesday–Thursday, peak hours 9am–1pm US Eastern.

---

### 🥈 Tier 2 — High Reach, Worth the Effort

#### D. ProductHunt Launch
**What:** Full PH launch with screenshots, GIFs (you already have apps.gif, studio.gif, lineage.gif, agent.gif — use all four), and a clear tagline.  
**Tagline options:**
- "The governed analytics workspace your dbt project deserves"
- "Git-native certified blocks for dbt — local-first, AI-ready"

**When:** Launch on a Tuesday or Wednesday, 12:01am PST (PH resets daily).  
**Prep:** Get 10–15 people to upvote within the first 2 hours (makers, colleagues, early users).  
**Coordinate:** Post PH link in HN + dbt Slack the same day.

#### E. Twitter/X Thread
**Thread structure (7 tweets):**
1. The problem: "Your dbt project has 400 models. Your BI tool has 300 dashboards. Nobody knows which query matches which dashboard. Sound familiar?"
2. The solution: what DQL is in one line
3. Demo GIF (apps.gif or lineage.gif)
4. The certification model — screenshot of Block Studio
5. The AI angle — governed answers from certified blocks only
6. The dbt integration — non-destructive, 2-minute setup
7. CTA: GitHub link + "Drop a ⭐ if this resonates"

**Tag:** `@dbt_labs`, `@MotherDuck` (DuckDB), `@getdbt` community accounts.  
**When:** Tuesday–Thursday 9–11am US Eastern.

#### F. LinkedIn Article
**Title:** "Why we built a governed analytics layer on top of dbt (and made it open source)"  
**Length:** 800–1000 words  
**Structure:**
- The messy reality: query sprawl in data teams
- What "certified" means and why it matters for AI
- How DQL fits in the dbt ecosystem (not a replacement)
- 2-minute demo CTA
- What's coming (cloud version)

---

### 🥉 Tier 3 — SEO + Long-Tail Discovery

#### G. Dev.to or Hashnode Article
**Best titles (SEO-optimized):**
- "From dbt model to governed AI answer in 5 minutes with DQL"
- "How to add certified blocks and lineage to your dbt project"
- "DQL vs Metabase vs Looker: why local-first analytics wins for dbt teams"

**Format:** Tutorial with code blocks. Walk through the Jaffle Shop end-to-end.  
Include: install command, first `.dql` file, certification, lineage command, AI query.

#### H. GitHub README Optimization
Before any of the above — make sure the README works hard:
- [ ] Add "⭐ Star us on GitHub" call-to-action in the first 3 lines
- [ ] Add animated GIF above the fold (apps.gif is already great)
- [ ] Add a "Compare to Looker/Metabase" table
- [ ] Add "Built with DQL" badge for adopters
- [ ] Add GitHub Topics: `dbt`, `duckdb`, `analytics`, `data-governance`, `lineage`, `analytics-engineering`

---

## 4. Content Calendar (4 Weeks to Cloud Launch)

| Week | Action | Channel | Output |
|------|--------|---------|--------|
| **Week 1** | Polish README + add GitHub Topics | GitHub | README v2 |
| **Week 1** | Record 90-second Loom/demo video (Acme Bank Docker run → dashboard → lineage) | YouTube / Twitter | Video |
| **Week 2** | Write the Dev.to tutorial article | Dev.to | Published article |
| **Week 2** | Write LinkedIn article | LinkedIn | Published article |
| **Week 3** | dbt Slack post | dbt Slack | Community thread |
| **Week 3** | r/dataengineering post | Reddit | Post + replies |
| **Week 4** | ProductHunt launch | ProductHunt | Launch page live |
| **Week 4** | Twitter/X thread | Twitter/X | Thread |
| **Week 4** | Show HN | Hacker News | HN post |

**Week 4 = launch week**: coordinate PH + HN + Twitter on the same day for maximum cross-amplification.

---

## 5. Demo / Tutorial Priorities

### Must-Have: The 90-Second Docker Demo
**Flow:** `docker compose up` → open browser → Acme Bank dashboard loads → click Block Studio → show certification badge → click Lineage → show DAG → ask AI question → get governed answer.

**Where to post:** YouTube (public), embedded in Dev.to article, linked from README, shared in every community post.

### Must-Have: Jaffle Shop Written Tutorial
**"Your first certified block in 5 minutes"**  
Steps: install → connect dbt → import model → write block → certify → ask AI.  
Post on Dev.to and cross-post to Hashnode.

### Nice-to-Have: "Migrate from Looker/Metabase" Walkthrough
You have `guides/migrate.md` already. Turn it into a Dev.to article. High SEO value, directly targets people actively searching for alternatives.

---

## 6. Key Talking Points (Use in All Channels)

- **Non-destructive on dbt**: "DQL reads your dbt project. It doesn't rewrite it."
- **Git-native governance**: "Every certified block is a file in git. Your PR review IS your governance workflow."
- **AI accuracy**: "AI answers only use certified, tested blocks — not raw SQL scraped from dashboards."
- **Full-stack lineage**: "From a source table all the way to the AI answer. One DAG."
- **14 connectors, DuckDB default**: "Works with Snowflake, BigQuery, Redshift, Databricks, and more. DuckDB runs locally with zero setup."
- **2-minute quickstart**: Always lead with the Docker command.

---

## 7. Metrics to Track

| Metric | Target (Pre-Cloud) | Tool |
|--------|-------------------|------|
| GitHub stars | 500+ | GitHub Insights |
| npm downloads | 1,000+ / month | npm stats |
| Discord/Slack members | 200+ | Community platform |
| HN Show HN points | 50+ | Hacker News |
| PH upvotes | Top 5 of the day | ProductHunt |

---

## 8. Scheduled Promotion Tasks (Automation Ideas)

Consider scheduling these with Claude:
- **Weekly**: Check GitHub issues for unanswered questions → draft responses
- **Weekly**: Monitor `#dbt` and `#duckdb` on Twitter for relevant conversations to join
- **Bi-weekly**: Check npm download stats and GitHub star trajectory
- **Monthly**: Write one new tutorial article based on community questions

---

*Generated: 2026-06-23 | Review before each channel post and update CTAs with current GitHub star count.*
