# DuckCode Analytics Platform — 90-Day OSS Promotion Plan
# DataLex + dbt + DQL | Campaign Start: 2026-06-23

**The unified message:** "From a raw dbt model to a certified AI answer — with a human-reviewed contract at every step."  
**Suite brand:** DuckCode Analytics Platform (DataLex → dbt → DQL)  
**Primary demo:** github.com/duckcode-ai/jaffle-shop-duckdb

---

## PHASE 1: Foundation (Days 1–30)
*Goal: Fix discovery gaps, build assets, align both repos before going public.*

---

### Week 1 — Cross-link & Tighten (Days 1–7)

**Day 1 (Mon Jun 23)**
- [ ] Add GitHub Topics to DQL repo: `dbt`, `duckdb`, `snowflake`, `databricks`, `analytics-engineering`, `data-governance`, `lineage`, `certified-analytics`
- [ ] Add GitHub Topics to DataLex repo: `dbt`, `data-contracts`, `data-governance`, `analytics-engineering`, `llm`, `ai-governance`

**Day 2 (Tue Jun 24)**
- [ ] Add a "Platform Overview" section to both READMEs with a shared diagram showing: DataLex → dbt → DQL → AI answer
- [ ] Link from DQL README → DataLex and vice versa — above the fold, not buried in docs

**Day 3 (Wed Jun 25)**
- [ ] Audit the jaffle-shop-duckdb README — ensure it prominently shows the full 3-tool flow and is the first link in both READMEs
- [ ] Add "See it in action → jaffle-shop-duckdb" call-to-action to both READMEs

**Day 4 (Thu Jun 26)**
- [ ] Write a one-paragraph "Platform Story" blurb you'll paste everywhere: what DataLex does, what dbt does, what DQL does, how they connect
- [ ] Draft your Twitter/X bio update: include "Building @duckcode_ai — governed analytics platform for dbt teams (DataLex + DQL)"

**Day 5 (Fri Jun 27)**
- [ ] Record a 90-second Loom: Docker run → DataLex generates contracts → DQL certifies block referencing that contract → AI query returns governed answer
- [ ] Upload to YouTube as unlisted (you'll make it public in Week 3)

**Day 6–7 (Weekend)**
- [ ] Rest. Review both READMEs with fresh eyes. Fix anything that's confusing to a first-time visitor.

---

### Week 2 — Asset Creation (Days 8–14)

**Day 8 (Mon Jun 30)**
- [ ] Write Dev.to article draft: *"How we built a governed AI analytics layer on top of dbt (and why it's open source)"*
- [ ] Focus: the problem (query sprawl + ungoverned AI), the 3-layer solution, the manifest handoff

**Day 9 (Tue Jul 1)**
- [ ] Finish and publish the Dev.to article
- [ ] Post to Hashnode as cross-post (takes 10 minutes with canonical URL set to Dev.to)

**Day 10 (Wed Jul 2)**
- [ ] Write the "manifest-spec" explainer post on Dev.to: *"An open contract format for governed dbt analytics"*
- [ ] This targets the data engineering / open standards community — different audience than the tool posts

**Day 11 (Thu Jul 3)**
- [ ] Publish manifest-spec article on Dev.to
- [ ] Share it in the OpenLineage Slack (#general) — this community cares about interoperability standards

**Day 12 (Fri Jul 4) — US holiday, lighter day**
- [ ] Set up a Discord server (or use the existing one from DataLex README: discord.gg/Dnm6bUvk) with channels: #announcements, #dql, #datalex, #show-and-tell, #help
- [ ] Add Discord invite to both READMEs

**Day 13–14 (Weekend)**
- [ ] Write draft of the LinkedIn article: *"Why we built a governed analytics layer on top of dbt"*

---

### Week 3 — Warm Community Outreach (Days 15–21)

**Day 15 (Mon Jul 7)**
- [ ] Make the Loom/YouTube video public
- [ ] Add video link to both READMEs and the jaffle-shop-duckdb README

**Day 16 (Tue Jul 8)**
- [ ] Post in dbt Slack #tools-and-integrations:
  > "Hey dbt community — built two OSS tools that sit above your dbt project without touching it: DataLex (AI-assisted domain contracts from your dbt evidence) and DQL (certified blocks + lineage + governed AI answers). Full demo with Jaffle Shop: github.com/duckcode-ai/jaffle-shop-duckdb — curious what you think about the certified contract model."
- [ ] Be present all day to reply to comments

**Day 17 (Wed Jul 9)**
- [ ] Post in dbt Slack #analytics-engineering (different channel, slightly different angle):
  > "Anyone using dbt contracts today? We built DataLex to generate and review domain-level contracts above dbt's physical contracts — AI proposes from your manifest evidence, humans certify, downstream tools enforce. Happy to share."
- [ ] Reply to anyone who engages

**Day 18 (Thu Jul 10)**
- [ ] Post in r/dataengineering:
  > Title: "I built an open-source governed AI analytics stack on top of dbt — DataLex (contracts) + DQL (certified blocks + lineage)"
  > Body: Walk through the problem → 3-layer solution → Docker demo → GitHub links
- [ ] Stay engaged in comments for 48 hours

**Day 19 (Fri Jul 11)**
- [ ] Publish LinkedIn article
- [ ] Tag: dbt Labs, Snowflake, Databricks — mention relevant accounts to expand reach

**Day 20 (Sat Jul 12)**
- [ ] Post in r/LocalLLaMA: *"Using local Ollama to generate certified dbt domain contracts — OSS tool that proposes, you review"*
- [ ] This community loves local AI + real workflows

**Day 21 (Sun Jul 13)**
- [ ] Review engagement from Week 3. Note every question asked, every objection raised — these become your next articles.

---

### Week 4 — First Twitter Push (Days 22–28)

**Day 22 (Mon Jul 14)**
- [ ] Post Twitter/X thread (7 tweets, see OSS-PROMOTION-PLAN.md for structure)
- [ ] Tag @dbt_labs, @SnowflakeDB, @databricks

**Day 23 (Tue Jul 15)**
- [ ] DM 3 data engineering influencers on Twitter/LinkedIn. Not a pitch — ask for feedback:
  - Target: people with 5k–50k followers in analytics engineering space
  - Message: "Built something for dbt teams on Snowflake/Databricks/DuckDB — would love your honest take on the governance model before we launch the cloud version."

**Day 24 (Wed Jul 16)**
- [ ] Post in Snowflake community (community.snowflake.com) and Databricks community forums: "Built a local-first governed analytics workspace on top of dbt — certified blocks, lineage, AI chat. Works with Snowflake, Databricks, and DuckDB. 2-min Docker demo."
- [ ] Both communities are full of dbt users who care about governance

**Day 25 (Thu Jul 17)**
- [ ] Reach out to 1 data engineering podcast (DataStack Show, Metadata Weekly, The Analytics Engineering Podcast)
- [ ] Email pitch: 3 sentences — what you built, why it's interesting, offer a 20-min demo

**Day 26 (Fri Jul 18)**
- [ ] Post in Locally Optimistic Slack (analytics leadership community)
- [ ] Angle: governance + AI accuracy — speaks to their audience (data leaders, not just engineers)

**Day 27–28 (Weekend)**
- [ ] Write second Dev.to tutorial: *"From dbt model to certified AI answer in 5 minutes"* — step-by-step with code

---

## PHASE 2: Community Launch (Days 31–60)
*Goal: Coordinated public launch across ProductHunt, HN, and Twitter.*

---

### Week 5 — Tutorial & Pre-Launch (Days 29–35)

**Day 29 (Mon Jul 21)**
- [ ] Publish second Dev.to tutorial
- [ ] Post in dbt Slack linking to it

**Day 30 (Tue Jul 22)**
- [ ] Write third Dev.to article: *"DQL vs Metabase vs Looker: why local-first wins for dbt teams"* — SEO article targeting people actively searching for BI tool alternatives
- [ ] Publish same day

**Day 31 (Wed Jul 23)**
- [ ] Prepare ProductHunt launch page: tagline, screenshots, GIFs (apps.gif, studio.gif, lineage.gif, agent.gif), description, maker comment
- [ ] Line up 10–15 people to upvote on launch day

**Day 32 (Thu Jul 24)**
- [ ] Set up GitHub Sponsors for both repos (even if you don't use it — signals active project)
- [ ] Add FUNDING.yml to both repos

**Day 33 (Fri Jul 25)**
- [ ] Prepare Show HN draft (DQL): "Show HN: DQL – local-first certified analytics blocks for dbt teams"
- [ ] Prepare Show HN draft (DataLex): "Show HN: DataLex – AI-assisted domain contracts above your dbt project"

**Day 34–35 (Weekend)**
- [ ] Final review of all launch assets. Make sure Docker demos work cleanly end-to-end.

---

### Week 6 — LAUNCH WEEK (Days 36–42)

**Day 36 (Mon Jul 27)**
- [ ] Announce to Discord: "Launch week is here — ProductHunt + HN dropping Wednesday"
- [ ] Email any beta users or early testers asking them to be ready to upvote

**Day 37 (Tue Jul 28)**
- [ ] Post teaser Twitter thread: "Something is launching Wednesday. Here's the problem it solves..." (no links yet, build anticipation)

**Day 38 (Wed Jul 29) — MAIN LAUNCH DAY**
- [ ] 12:01am PST: DQL goes live on ProductHunt
- [ ] 8am PST: Post "Show HN: DQL" on Hacker News
- [ ] 8am PST: Twitter/X thread linking PH + HN
- [ ] 8am PST: Post in dbt Slack, r/dataengineering, Snowflake community, Databricks community simultaneously
- [ ] Stay online all day replying to every comment

**Day 39 (Thu Jul 30)**
- [ ] 12:01am PST: DataLex goes live on ProductHunt (stagger by 1 day to avoid competing with yourself)
- [ ] 8am PST: Post "Show HN: DataLex" on Hacker News
- [ ] Link the two PH pages as companion tools in each maker comment

**Day 40 (Fri Jul 31)**
- [ ] Write a launch recap post for LinkedIn: what happened, lessons learned, thank-you to the community
- [ ] This converts launch momentum into ongoing followers

**Day 41–42 (Weekend)**
- [ ] Respond to all remaining HN + PH comments
- [ ] Document every question you were asked — each one is an article or FAQ entry

---

### Weeks 7–9 — Sustain & Deepen (Days 43–60)

**Day 43 (Mon Aug 3)**
- [ ] Reach out to dbt Labs directly via GitHub Discussions or their community Slack: "We built DataLex + DQL as a governed analytics layer above dbt — would love to be featured in the ecosystem directory"
- [ ] Check: https://www.getdbt.com/ecosystem

**Day 45 (Wed Aug 5)**
- [ ] Write article: *"What 'certified' means in analytics — and why it matters for AI accuracy"*
- [ ] Post on Dev.to and LinkedIn simultaneously

**Day 47 (Fri Aug 7)**
- [ ] Post in r/MachineLearning or r/LangChain: "How we use certified dbt contracts to constrain LLM answer quality in analytics"
- [ ] This AI + governance angle plays well in the LLM community

**Day 49 (Sun Aug 9)**
- [ ] Check GitHub star velocity on both repos. If <200 stars on DQL, do another targeted Twitter thread next week.

**Day 51 (Tue Aug 11)**
- [ ] Record second video: the DataLex side — show AI generating domain proposals from Jaffle Shop manifest, review UI, publish manifest, open DQL and see blocks referencing the contract
- [ ] Post to YouTube, embed in DataLex README

**Day 53 (Thu Aug 13)**
- [ ] Podcast follow-up: if no response from Day 25 outreach, try 2 more podcasts
- [ ] Also try: "Analytics Engineering Podcast" by dbt Labs — they cover tooling

**Day 55 (Sat Aug 15)**
- [ ] Post a "what we've learned from the community" Twitter thread — answer the top 5 questions you've received
- [ ] This type of post builds trust and often outperforms the original launch posts

**Day 57 (Mon Aug 17)**
- [ ] Submit DataLex + DQL to OSS data tool directories:
  - awesome-dbt (GitHub list — open a PR)
  - awesome-data-engineering (GitHub list)
  - Open Source Alternatives (opensourcealternative.to)

**Day 59 (Wed Aug 19)**
- [ ] Write article: *"The open manifest format connecting DataLex contracts to DQL certified blocks"*
- [ ] This targets the data platform engineering audience who care about interoperability

---

## PHASE 3: Cloud Preview & Ecosystem (Days 61–90)
*Goal: Build waitlist for cloud, establish ecosystem partnerships, sustain content.*

---

### Week 10 — Cloud Teaser (Days 61–67)

**Day 61 (Fri Aug 21)**
- [ ] Add a "Coming soon: DuckCode Cloud" section to both READMEs with a waitlist link (use a simple Typeform or Google Form)
- [ ] The cloud waitlist converts OSS users into commercial leads

**Day 63 (Sun Aug 23)**
- [ ] Twitter thread: "Here's what DataLex + DQL OSS can't do (yet) — and what the cloud version will unlock"
- [ ] Honest framing builds trust. Preview: multi-user RBAC, managed secrets, audit logs, approval workflows

**Day 65 (Tue Aug 25)**
- [ ] Post in r/dataengineering: cloud preview announcement + waitlist link

**Day 67 (Thu Aug 27)**
- [ ] Reach out to 3 data teams at companies using dbt (find them via dbt's "Who uses dbt" page or LinkedIn) and offer a free private demo in exchange for feedback

---

### Weeks 11–13 — Content Depth & SEO (Days 68–90)

**Day 70 (Sun Aug 30)**
- [ ] Write article: *"Migrate from Looker to DQL in a weekend"* — based on your existing migrate.md guide
- [ ] High SEO value. Targets people actively searching for Looker alternatives.

**Day 72 (Tue Sep 1)**
- [ ] Post in Locally Optimistic Slack again — this time with cloud preview angle

**Day 74 (Thu Sep 3)**
- [ ] Submit to the dbt Package Hub or ecosystem registry if applicable
- [ ] Check if dbt Labs has an "Integrations" page where you can list DataLex + DQL

**Day 77 (Sun Sep 6)**
- [ ] Write article: *"How we used Claude + DataLex to generate 40 certified dbt domain contracts in an afternoon"*
- [ ] AI + dbt + real workflow story — high shareability

**Day 79 (Tue Sep 8)**
- [ ] Share that article in Anthropic's Discord / developer communities (you're using Claude — that's a natural fit)

**Day 81 (Thu Sep 10)**
- [ ] Do a live demo stream on YouTube or X Spaces: "Live: building a governed AI analytics workspace from a Snowflake/Databricks dbt project"
- [ ] Announce 48 hours in advance in Discord + dbt Slack + Twitter

**Day 84 (Sun Sep 13)**
- [ ] Write 30-day retrospective post: "One month since launch — what happened, what we learned, where we're headed"
- [ ] Post on LinkedIn and Dev.to

**Day 86 (Tue Sep 15)**
- [ ] Compile a "community FAQ" doc from all questions received — add to both repos as FAQ.md
- [ ] Post the key questions + answers as a Twitter thread

**Day 88 (Thu Sep 17)**
- [ ] Announce cloud waitlist milestone (e.g., "500 people on the waitlist — thank you") if applicable
- [ ] Post to all channels

**Day 90 (Sat Sep 19) — Campaign End**
- [ ] Write the full 90-day retrospective:
  - GitHub stars: DQL ___ / DataLex ___
  - npm downloads: ___
  - PyPI downloads: ___
  - Discord members: ___
  - Cloud waitlist: ___
  - Articles published: ___
  - Community channels reached: ___
- [ ] Plan Phase 2: cloud beta launch campaign

---

## Quick Reference — Communities to Reach

| Community | Platform | Best angle |
|-----------|----------|-----------|
| dbt Slack #tools-and-integrations | Slack | dbt integration, non-destructive |
| dbt Slack #analytics-engineering | Slack | certified contracts, governance |
| r/dataengineering | Reddit | full stack, OSS story |
| r/LocalLLaMA | Reddit | local Ollama + AI proposals |
| Snowflake Community (community.snowflake.com) | Forum | governed AI answers on Snowflake + dbt |
| Databricks Community (community.databricks.com) | Forum | certified analytics on Databricks + dbt |
| DuckDB Discord | Discord | local-first dev/analyst workflows |
| Locally Optimistic Slack | Slack | governance, data leadership |
| OpenLineage Slack | Slack | manifest-spec, interoperability |
| Hacker News | HN | technical depth, Show HN |
| ProductHunt | PH | broad audience, design |
| Twitter/X | X | data community, influencers |
| LinkedIn | LinkedIn | professional, leadership |
| Dev.to / Hashnode | Blog | SEO, tutorials |
| Anthropic Discord | Discord | Claude AI integration |

## Key People to Reach

| Who | Why | How |
|-----|-----|-----|
| dbt Labs team | Ecosystem listing, potential blog collab | GitHub Discussion or dbt Slack DM |
| Snowflake developer relations | Governance + AI on Snowflake story | Twitter DM or devrel@snowflake.com |
| Databricks developer relations | Governed analytics on Databricks + dbt | Twitter DM or Databricks community |
| Analytics engineering influencers (5k–50k followers) | Amplification | Twitter DM, offer early access |
| Data podcast hosts | Long-form story, reach their audience | Email pitch |
| dbt package maintainers | Technical credibility | GitHub Issues / Discussion |

---

*This plan is read daily by a scheduled Claude task. Each morning you receive today's 1–2 action items with full context on what to do, where to go, and what to say.*
