import { useMemo, useState } from "react"
import {
  ArrowLeft, ArrowRight, BriefcaseBusiness, CalendarDays, Check, ChevronDown,
  CircleHelp, ClipboardList, Copy, Mail, MapPin, MessageSquareText,
  Plus, Search, Send, SlidersHorizontal, Sparkles, Users, X,
} from "lucide-react"
import { ChatContainer, MainContainer, Message, MessageInput, MessageList } from "@chatscope/chat-ui-kit-react"
import "@chatscope/chat-ui-kit-styles/dist/default/styles.min.css"
import { rankCandidates, scoreCandidate, type DemoCandidate, type ScoreAxis } from "./sourcing-demo-score.js"
import "./sourcing-studio-demo.css"

type Candidate = DemoCandidate & {
  initials: string
  color: string
  years: string
  previous: string[]
  skillsList: string[]
  visa: string
  salary: string
  linkedin: string
  summary: string
  companyDetail: string
  companySize: string
  companyHQ: string
  email: string
}

type Tab = "discover" | "contacts" | "sequences" | "interviews" | "playbook"
type ChatLine = { id: number; text: string; sender: "Claire" | "You" }

const SAMPLE_JD = "We are hiring a Senior Account Executive to sell a property operations platform to multifamily owners. We need 4+ years of B2B SaaS sales, full-cycle closing, and experience selling into real estate teams."

const CANDIDATES: Candidate[] = [
  {
    id: "morgan", name: "Morgan Lee", initials: "ML", color: "peach", role: "Senior Account Executive", company: "LeasePilot", location: "Los Angeles, CA", years: "6 years in B2B sales", previous: ["VTS", "AppFolio"], skillsList: ["PropTech", "Full-cycle sales", "Multifamily"], visa: "Not shown", salary: "$145k–$170k OTE", linkedin: "linkedin.com/in/morgan-lee-demo", email: "Not available", experience: 96, skills: 93, locationFit: 100, compensationFit: 86, summary: "Closed mid-market property-management accounts and grew an LA territory. Direct overlap with multifamily buyers and full-cycle SaaS sales.", companyDetail: "Property operations software", companySize: "201–500 employees", companyHQ: "Los Angeles, CA",
  },
  {
    id: "avery", name: "Avery Patel", initials: "AP", color: "lavender", role: "Account Executive", company: "Buildium", location: "San Diego, CA", years: "5 years in SaaS sales", previous: ["RealPage", "HubSpot"], skillsList: ["Real estate", "Pipeline creation", "Closing"], visa: "Not shown", salary: "$135k–$160k OTE", linkedin: "linkedin.com/in/avery-patel-demo", email: "Not available", experience: 91, skills: 89, locationFit: 75, compensationFit: 95, summary: "Sold property-management software to residential operators. Strong buyer overlap; location would need a conversation.", companyDetail: "Property-management platform", companySize: "501–1,000 employees", companyHQ: "Boston, MA",
  },
  {
    id: "jordan", name: "Jordan Brooks", initials: "JB", color: "sage", role: "Enterprise Account Executive", company: "Procore", location: "Los Angeles, CA", years: "8 years in enterprise sales", previous: ["CoStar", "Yardi"], skillsList: ["Enterprise sales", "Real estate", "Strategic accounts"], visa: "Not shown", salary: "$180k–$210k OTE", linkedin: "linkedin.com/in/jordan-brooks-demo", email: "Not available", experience: 88, skills: 85, locationFit: 100, compensationFit: 38, summary: "Deep real-estate technology background and local network. Compensation is above the sample range and needs review.", companyDetail: "Construction management software", companySize: "1,001–5,000 employees", companyHQ: "Carpinteria, CA",
  },
  {
    id: "sam", name: "Sam Rivera", initials: "SR", color: "blue", role: "Commercial Account Executive", company: "VTS", location: "New York, NY", years: "4 years in commercial sales", previous: ["Zillow", "Compass"], skillsList: ["PropTech", "Outbound", "Land-and-expand"], visa: "Not shown", salary: "$120k–$150k OTE", linkedin: "linkedin.com/in/sam-rivera-demo", email: "Not available", experience: 82, skills: 87, locationFit: 45, compensationFit: 100, summary: "Relevant commercial real-estate network with strong outbound motion. Relocation or remote fit is unconfirmed.", companyDetail: "Commercial real-estate leasing platform", companySize: "501–1,000 employees", companyHQ: "New York, NY",
  },
  {
    id: "taylor", name: "Taylor Kim", initials: "TK", color: "gold", role: "Account Executive", company: "Gong", location: "Los Angeles, CA", years: "5 years in SaaS sales", previous: ["Salesforce", "OpenTable"], skillsList: ["Full-cycle sales", "SaaS", "Forecasting"], visa: "Not shown", salary: "$140k–$165k OTE", linkedin: "linkedin.com/in/taylor-kim-demo", email: "Not available", experience: 71, skills: 77, locationFit: 100, compensationFit: 90, summary: "Strong SaaS sales fundamentals and local fit. No clear property-operations or multifamily selling evidence in the sample profile.", companyDetail: "Revenue intelligence software", companySize: "1,001–5,000 employees", companyHQ: "San Francisco, CA",
  },
]

const PROMPTS = [
  "Paste the job description to start. I’ll turn it into a sourcing brief.",
  "Where should this person work? Include remote or relocation flexibility if relevant.",
  "What compensation range should I use? Base or OTE is fine.",
  "Does this role offer visa sponsorship, or should I flag visa status for review?",
  "Which previous companies or types of companies matter most?",
]

const QUICK_ANSWERS: Record<number, string[]> = {
  1: ["Los Angeles · hybrid", "Remote · US", "On-site · Los Angeles"],
  2: ["$120k–$160k OTE", "$160k–$200k OTE", "Open to discuss"],
  3: ["Sponsorship available", "No sponsorship", "Flag for review"],
  4: ["PropTech SaaS", "Real estate operators", "No company preference"],
}

const BRIEF_LABELS = ["Job description", "Location & work model", "Compensation", "Visa sponsorship", "Relevant companies"]

const AXES: { value: ScoreAxis; label: string }[] = [
  { value: "overall", label: "Overall match" },
  { value: "experience", label: "Relevant experience" },
  { value: "skills", label: "Skills overlap" },
  { value: "location", label: "Location fit" },
  { value: "compensation", label: "Compensation fit" },
]

function IconButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return <button className="ssd-icon-button" type="button" aria-label={label} onClick={onClick}>{children}</button>
}

export default function SourcingStudioDemo() {
  const [tab, setTab] = useState<Tab>("discover")
  const [step, setStep] = useState(0)
  const [answers, setAnswers] = useState<string[]>([])
  const [lines, setLines] = useState<ChatLine[]>([{ id: 0, text: PROMPTS[0], sender: "Claire" }])
  const [sort, setSort] = useState<ScoreAxis>("overall")
  const [selected, setSelected] = useState<string[]>([])
  const [profile, setProfile] = useState<Candidate | null>(null)
  const [profileTab, setProfileTab] = useState<"overview" | "experience" | "activity">("overview")
  const [sequenceStatus, setSequenceStatus] = useState<"draft" | "review">("draft")
  const [note, setNote] = useState("")
  const [notes, setNotes] = useState<Record<string, string[]>>({})
  const [slot, setSlot] = useState("Tue, Oct 6 · 10:00 AM")
  const [scheduled, setScheduled] = useState<string[]>([])
  const [interviewPreview, setInterviewPreview] = useState(false)
  const resultsReady = step >= PROMPTS.length
  const ranked = useMemo(() => rankCandidates(CANDIDATES, sort), [sort])
  const selectedCandidates = CANDIDATES.filter((candidate) => selected.includes(candidate.id))

  function submitAnswer(value: string) {
    const text = value.trim()
    if (!text || resultsReady) return
    const next = step + 1
    setAnswers((current) => [...current, text])
    setLines((current) => [
      ...current,
      { id: current.length, text, sender: "You" },
      { id: current.length + 1, text: next < PROMPTS.length ? PROMPTS[next] : "Sourcing brief ready. I found five sample profiles to explore. You can re-rank them, review the evidence, and draft outreach.", sender: "Claire" },
    ])
    setStep(next)
  }

  function toggleSelected(id: string) {
    setSequenceStatus("draft")
    setInterviewPreview(false)
    setSelected((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id])
  }

  function addNote() {
    if (!profile || !note.trim()) return
    setNotes((current) => ({ ...current, [profile.id]: [...(current[profile.id] || []), note.trim()] }))
    setNote("")
  }

  return (
    <div className="ssd">
      <div className="ssd-heading">
        <div>
          <span className="ssd-eyebrow"><span className="ssd-live-dot" /> INTERACTIVE CONCEPT · SAMPLE DATA</span>
          <h1>Sourcing studio<span>.</span></h1>
          <p>From a job brief to a thoughtful first conversation.</p>
        </div>
        <div className="ssd-heading-actions">
          <span className="ssd-demo-pill">Prototype · no live sending</span>
          <button type="button" className="ssd-secondary" onClick={() => { setTab("discover"); setStep(0); setAnswers([]); setLines([{ id: 0, text: PROMPTS[0], sender: "Claire" }]); setSelected([]); setSequenceStatus("draft"); setScheduled([]); setInterviewPreview(false) }}>New search <Plus size={15} /></button>
        </div>
      </div>

      <nav className="ssd-tabs" aria-label="Sourcing workflow">
        {([
          ["discover", Search, "Discover"], ["contacts", Users, "Contacts"],
          ["sequences", Send, "Sequences"], ["interviews", CalendarDays, "Interviews"],
          ["playbook", ClipboardList, "Playbook"],
        ] as const).map(([key, Icon, label]) => (
          <button type="button" key={key} className={tab === key ? "active" : ""} onClick={() => setTab(key)}><Icon size={16} />{label}{key === "contacts" && selected.length > 0 && <b>{selected.length}</b>}</button>
        ))}
      </nav>

      {tab === "discover" && <>
        <div className="ssd-workspace">
          <section className="ssd-chat-pane" aria-label="Sourcing chat">
            <div className="ssd-pane-head"><div><span className="ssd-pane-kicker">01 / BRIEF</span><h2>Tell Claire about the role</h2></div><MessageSquareText size={18} /></div>
            <div className="ssd-chat-intro"><Sparkles size={16} /><span>Autumn-inspired intake · guided by your answers</span></div>
            <div className="ssd-chat-kit">
              <MainContainer><ChatContainer>
                <MessageList>
                  {lines.map((line) => <Message key={line.id} model={{ message: line.text, sender: line.sender, direction: line.sender === "You" ? "outgoing" : "incoming", position: "single" }} />)}
                </MessageList>
                {!resultsReady && <MessageInput key={step} placeholder={step === 0 ? "Paste a job description…" : "Type your answer…"} attachButton={false} onSend={(value: string) => submitAnswer(value)} />}
              </ChatContainer></MainContainer>
            </div>
            {!resultsReady ? <div className="ssd-chat-footer">
              {step === 0 ? <button type="button" onClick={() => submitAnswer(SAMPLE_JD)}>Use sample job description <ArrowRight size={14} /></button> : <div className="ssd-quick-answers">{QUICK_ANSWERS[step]?.map((answer) => <button key={answer} type="button" onClick={() => submitAnswer(answer)}>{answer}</button>)}<button type="button" onClick={() => submitAnswer("Not specified · review later")}>Skip</button></div>}
              <span>{step + 1} of {PROMPTS.length}</span>
            </div> : <div className="ssd-chat-footer"><span className="ssd-ready"><Check size={14} /> Brief complete</span><button type="button" onClick={() => { setStep(0); setAnswers([]); setLines([{ id: 0, text: PROMPTS[0], sender: "Claire" }]); setSelected([]); setSequenceStatus("draft"); setScheduled([]); setInterviewPreview(false) }}>Start over <ArrowRight size={14} /></button></div>}
          </section>

          <section className="ssd-results-pane" aria-label="Candidate matches">
            {!resultsReady ? step === 0 ? <div className="ssd-empty"><div className="ssd-orbit"><Search size={33} /></div><span className="ssd-pane-kicker">02 / DISCOVER</span><h2>Good sourcing starts with a clear brief.</h2><p>Answer a few questions on the left. Then explore a ranked candidate list, compare match evidence, and build an outreach batch.</p><div className="ssd-steps"><span>01 &nbsp; Brief</span><i /><span>02 &nbsp; Match</span><i /><span>03 &nbsp; Reach out</span></div></div> : <div className="ssd-live-brief"><span className="ssd-pane-kicker">LIVE SEARCH CRITERIA</span><h2>Shape the search before it runs.</h2><p>Your answers become the brief. Missing details stay visible so the results can be reviewed honestly.</p><div className="ssd-brief-items">{BRIEF_LABELS.map((label, index) => <div className="ssd-brief-item" key={label}><span>{label}</span><strong className={answers[index] ? "" : "ssd-unset"}>{answers[index] || "Not specified"}</strong></div>)}</div><span className="ssd-brief-progress">{step} of {PROMPTS.length} fields captured</span></div> : <>
              <div className="ssd-pane-head ssd-results-head"><div><span className="ssd-pane-kicker">02 / DISCOVER</span><h2>Candidate matches <small>5 sample profiles</small></h2></div><button type="button" className="ssd-secondary" onClick={() => setTab("sequences")}>Build outreach <ArrowRight size={15} /></button></div>
              <div className="ssd-brief-strip"><BriefcaseBusiness size={17} /><div><strong>Senior Account Executive</strong><span>{answers[1] || "Location open"} · {answers[2] || "Compensation open"}</span></div><span className="ssd-fixture-label">Illustrative result set</span></div>
              <div className="ssd-results-controls"><div className="ssd-control-label"><SlidersHorizontal size={15} /> Rank by</div><label className="ssd-select"><span className="sr-only">Rank candidates by</span><select value={sort} onChange={(event) => setSort(event.target.value as ScoreAxis)}>{AXES.map((axis) => <option key={axis.value} value={axis.value}>{axis.label}</option>)}</select><ChevronDown size={14} /></label><span className="ssd-select-count">{selected.length} shortlisted</span></div>
              <div className="ssd-candidate-list">{ranked.map((candidate, index) => <article key={candidate.id} className="ssd-candidate-row">
                <input type="checkbox" aria-label={`Shortlist ${candidate.name}`} checked={selected.includes(candidate.id)} onChange={() => toggleSelected(candidate.id)} />
                <div className={`ssd-avatar ${candidate.color}`}>{candidate.initials}</div>
                <button type="button" className="ssd-candidate-main" onClick={() => { setProfile(candidate); setProfileTab("overview") }}><span className="ssd-rank">#{String(index + 1).padStart(2, "0")}</span><strong>{candidate.name}</strong><span>{candidate.role} at {candidate.company}</span><span className="ssd-location"><MapPin size={12} />{candidate.location} · {candidate.years}</span><span className="ssd-candidate-evidence">{candidate.summary}</span></button>
                <div className="ssd-candidate-end"><span className="ssd-score">{sort === "overall" ? scoreCandidate(candidate) : sort === "location" ? candidate.locationFit : sort === "compensation" ? candidate.compensationFit : candidate[sort]}<small>/100</small></span><span>{AXES.find((axis) => axis.value === sort)?.label}</span><IconButton label={`View ${candidate.name}`} onClick={() => { setProfile(candidate); setProfileTab("overview") }}><ArrowRight size={17} /></IconButton></div>
              </article>)}</div>
              <div className="ssd-results-foot"><span><CircleHelp size={14} /> Demo score: experience 45%, skills 30%, location 15%, compensation 10%. Visa is left for review.</span><button type="button" onClick={() => setTab("playbook")}>See workflow <ArrowRight size={14} /></button></div>
            </>}
          </section>
        </div>
      </>}

      {tab === "contacts" && <section className="ssd-secondary-view"><div className="ssd-view-title"><span className="ssd-pane-kicker">03 / ORGANIZE</span><h2>Contacts</h2><p>Your working shortlist for this role. Select candidates in Discover to add them here.</p></div>{selectedCandidates.length === 0 ? <EmptySection icon={<Users size={30} />} title="No contacts selected yet" action="Explore matches" onAction={() => setTab("discover")} /> : <div className="ssd-contact-grid">{selectedCandidates.map((candidate) => <button key={candidate.id} type="button" className="ssd-contact-card" onClick={() => setProfile(candidate)}><span className={`ssd-avatar ${candidate.color}`}>{candidate.initials}</span><strong>{candidate.name}</strong><span>{candidate.role} · {candidate.company}</span><em>{candidate.location}</em><span className="ssd-contact-card-foot">View profile <ArrowRight size={15} /></span></button>)}</div>}</section>}

      {tab === "sequences" && <section className="ssd-secondary-view"><div className="ssd-view-title"><span className="ssd-pane-kicker">04 / OUTREACH</span><h2>Build a first-touch sequence</h2><p>Preview a batch before sending. This demo creates no emails or external tasks.</p></div><div className="ssd-sequence-grid"><div className="ssd-sequence-panel"><div className="ssd-section-top"><h3>Recipients</h3><span>{selectedCandidates.length} selected</span></div>{selectedCandidates.length ? selectedCandidates.map((candidate) => <div className="ssd-recipient" key={candidate.id}><span className={`ssd-avatar ${candidate.color}`}>{candidate.initials}</span><div><strong>{candidate.name}</strong><small>{candidate.company} · Email unverified</small></div><button type="button" onClick={() => toggleSelected(candidate.id)} aria-label={`Remove ${candidate.name}`}><X size={15} /></button></div>) : <p className="ssd-muted">Shortlist candidates from Discover to populate this batch.</p>}<button type="button" className="ssd-text-action" onClick={() => setTab("discover")}>Add from matches <Plus size={14} /></button></div><div className="ssd-sequence-panel"><div className="ssd-section-top"><h3>Sequence preview</h3><span>3 steps · 8 days</span></div><div className="ssd-sequence-step"><b>01</b><div><strong>Personalized introduction</strong><span>Day 0 · Email draft</span><p>Hi [first name], your work at [company] stood out. We’re helping a property-operations team find a Senior Account Executive…</p></div></div><div className="ssd-sequence-step"><b>02</b><div><strong>Relevant role context</strong><span>Day 4 · Follow-up draft</span></div></div><div className="ssd-sequence-step"><b>03</b><div><strong>Close the loop</strong><span>Day 8 · Final follow-up draft</span></div></div><button type="button" className="ssd-primary" disabled={!selectedCandidates.length} onClick={() => setSequenceStatus("review")}>{sequenceStatus === "review" ? "Batch staged for review" : "Stage batch for review"} <ArrowRight size={16} /></button><small className="ssd-safety-note">Email availability and suppression checks would be required before live send.</small></div></div></section>}

      {tab === "interviews" && <section className="ssd-secondary-view"><div className="ssd-view-title"><span className="ssd-pane-kicker">05 / CONVERT</span><h2>Interview planning</h2><p>A scheduling workspace for candidates who respond and opt in.</p></div><div className="ssd-interview-layout"><div className="ssd-sequence-panel"><div className="ssd-section-top"><h3>People to invite</h3><span>{selectedCandidates.length} shortlisted</span></div>{selectedCandidates.length ? selectedCandidates.map((candidate) => <label key={candidate.id} className="ssd-invite-row"><input type="checkbox" checked={scheduled.includes(candidate.id)} onChange={() => { setInterviewPreview(false); setScheduled((current) => current.includes(candidate.id) ? current.filter((item) => item !== candidate.id) : [...current, candidate.id]) }} /><span className={`ssd-avatar ${candidate.color}`}>{candidate.initials}</span><span><strong>{candidate.name}</strong><small>{candidate.role}</small></span></label>) : <p className="ssd-muted">Shortlist candidates first to plan interviews.</p>}</div><div className="ssd-sequence-panel"><div className="ssd-section-top"><h3>Suggested slot</h3><CalendarDays size={18} /></div><label className="ssd-form-label">Interview time<select value={slot} onChange={(event) => { setSlot(event.target.value); setInterviewPreview(false) }}><option>Tue, Oct 6 · 10:00 AM</option><option>Wed, Oct 7 · 2:00 PM</option><option>Thu, Oct 8 · 11:30 AM</option></select></label><div className="ssd-schedule-preview"><strong>Invite preview</strong><p>30-minute introductory conversation with the hiring team.</p><span>{slot}</span></div><button type="button" className="ssd-primary" disabled={!scheduled.length} onClick={() => setInterviewPreview(true)}>Preview {scheduled.length || ""} invitation{scheduled.length === 1 ? "" : "s"} <ArrowRight size={16} /></button>{interviewPreview && <div className="ssd-invite-preview"><strong>Invitation draft ready</strong><p>{scheduled.length} candidate{scheduled.length === 1 ? "" : "s"} · {slot} · 30-minute introduction</p><span>Review candidate interest and time zone before booking.</span></div>}<small className="ssd-safety-note">No calendar event or invitation is created in this demo.</small></div></div></section>}

      {tab === "playbook" && <section className="ssd-secondary-view"><div className="ssd-view-title"><span className="ssd-pane-kicker">OPERATING MODEL</span><h2>Recruiting playbook</h2><p>One visible path from demand to conversation, with review at the important handoffs.</p></div><div className="ssd-playbook">{[
        ["01", "Shape the brief", "Paste a job description. Clarify location, pay, sponsorship, and target-company experience.", "discover"],
        ["02", "Find and explain", "Autumn API result fields would populate profiles. Show LinkedIn, work history, company context, and score evidence.", "discover"],
        ["03", "Curate contacts", "Shortlist people. Check identity, contact reachability, and fit before outreach.", "contacts"],
        ["04", "Review outreach", "Draft a batch sequence, check suppressions, then approve before a real email integration sends.", "sequences"],
        ["05", "Book the first call", "Use interested replies to offer interview slots and track the next step.", "interviews"],
      ].map(([number, title, detail, target]) => <button type="button" key={number} onClick={() => setTab(target as Tab)}><span>{number}</span><div><strong>{title}</strong><p>{detail}</p></div><ArrowRight size={17} /></button>)}</div></section>}

      {profile && <div className="ssd-drawer-overlay" onClick={() => setProfile(null)}><aside className="ssd-drawer" role="dialog" aria-modal="true" aria-label={`${profile.name} profile`} onClick={(event) => event.stopPropagation()}><div className="ssd-drawer-top"><span className="ssd-pane-kicker">CANDIDATE PROFILE · SAMPLE</span><IconButton label="Close profile" onClick={() => setProfile(null)}><X size={20} /></IconButton></div><div className="ssd-drawer-person"><span className={`ssd-avatar ${profile.color}`}>{profile.initials}</span><div><h2>{profile.name}</h2><p>{profile.role} at {profile.company}</p><span><MapPin size={13} /> {profile.location}</span></div><span className="ssd-score">{scoreCandidate(profile)}<small>/100</small></span></div><div className="ssd-drawer-actions"><button type="button" className="ssd-secondary" onClick={() => toggleSelected(profile.id)}>{selected.includes(profile.id) ? <Check size={15} /> : <Plus size={15} />}{selected.includes(profile.id) ? "Shortlisted" : "Shortlist"}</button><button type="button" className="ssd-secondary" onClick={() => { setProfile(null); setTab("sequences") }}><Mail size={15} /> Outreach preview</button></div><div className="ssd-drawer-tabs">{(["overview", "experience", "activity"] as const).map((key) => <button type="button" key={key} className={profileTab === key ? "active" : ""} onClick={() => setProfileTab(key)}>{key}</button>)}</div>{profileTab === "overview" && <div className="ssd-drawer-body"><div className="ssd-match-note"><Sparkles size={16} /><p>{profile.summary}</p></div><h3>Profile details</h3><dl><div><dt>LinkedIn URL</dt><dd><code>{profile.linkedin}</code><button type="button" aria-label="Copy sample LinkedIn URL" onClick={() => void navigator.clipboard?.writeText(`https://www.${profile.linkedin}`)}><Copy size={14} /></button></dd></div><div><dt>Compensation</dt><dd>{profile.salary}</dd></div><div><dt>Visa status</dt><dd>{profile.visa} · verify directly</dd></div><div><dt>Email</dt><dd>{profile.email}</dd></div></dl><h3>Current company</h3><div className="ssd-company"><div className="ssd-company-logo">{profile.company[0]}</div><div><strong>{profile.company}</strong><p>{profile.companyDetail}</p><span>{profile.companySize} · HQ {profile.companyHQ}</span></div></div><h3>Match breakdown</h3><p className="ssd-muted">Illustrative scores from sample records. A connected Autumn result should show source links and mark unverified criteria as unclear.</p>{[["Relevant experience", profile.experience], ["Skills overlap", profile.skills], ["Location fit", profile.locationFit], ["Compensation fit", profile.compensationFit]].map(([label, value]) => <div className="ssd-bar-row" key={label}><span>{label}</span><b>{value}</b><i><i style={{ width: `${value}%` }} /></i></div>)}</div>}{profileTab === "experience" && <div className="ssd-drawer-body"><h3>Work history</h3><div className="ssd-history"><b>{profile.company}</b><strong>{profile.role}</strong><span>Current · {profile.years}</span></div>{profile.previous.map((company) => <div className="ssd-history" key={company}><b>{company}</b><span>Previous company · sample record</span></div>)}<h3>Skills</h3><div className="ssd-tags">{profile.skillsList.map((skill) => <span key={skill}>{skill}</span>)}</div></div>}{profileTab === "activity" && <div className="ssd-drawer-body"><h3>Notes</h3><textarea aria-label="Candidate note" placeholder="Add a recruiting note…" value={note} onChange={(event) => setNote(event.target.value)} /><button type="button" className="ssd-primary" onClick={addNote}>Add note <Plus size={15} /></button>{(notes[profile.id] || []).map((item, index) => <p className="ssd-note" key={`${index}-${item}`}>{item}</p>)}<h3>Next steps</h3><p className="ssd-muted">Shortlist this person, stage an outreach preview, and plan an interview after they respond.</p></div>}</aside></div>}
    </div>
  )
}

function EmptySection({ icon, title, action, onAction }: { icon: React.ReactNode; title: string; action: string; onAction: () => void }) {
  return <div className="ssd-empty-section">{icon}<h3>{title}</h3><button type="button" className="ssd-primary" onClick={onAction}>{action} <ArrowRight size={16} /></button></div>
}
