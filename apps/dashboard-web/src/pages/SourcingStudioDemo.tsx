import { useMemo, useState } from "react"
import {
  ArrowLeft, ArrowRight, Bookmark, BriefcaseBusiness, Building2, CalendarDays,
  Check, ChevronLeft, ChevronRight, Clock3, Copy, FolderOpen, GraduationCap,
  Inbox, LayoutGrid, List, Mail, MapPin, MessageCircle, PanelLeft, Plus,
  PlusCircle, Search, Send, SlidersHorizontal, Sparkles, WandSparkles, X,
} from "lucide-react"
import { ChatContainer, MainContainer, Message, MessageInput, MessageList } from "@chatscope/chat-ui-kit-react"
import "@chatscope/chat-ui-kit-styles/dist/default/styles.min.css"
import { CANDIDATES, SAMPLE_JD, type Candidate } from "./sourcing-demo-data.js"
import { rankCandidates, scoreCandidate, type ScoreAxis } from "./sourcing-demo-score.js"
import "./sourcing-studio-demo.css"

type View = "new" | "brief" | "results" | "shortlist" | "sequence" | "inbox" | "interview" | "workflow"
type ChatLine = { sender: "Scout" | "You"; text: string }
type SequenceStep = { subject: string; body: string; wait: string }

const FOLLOWUPS = [
  { label: "Location & work model", question: "Where should this person work? Is hybrid, remote, or relocation possible?", choices: ["Los Angeles · hybrid", "Los Angeles · on-site", "Remote · US"] },
  { label: "Compensation", question: "What compensation range should I use? Base or OTE is fine.", choices: ["$120k–$160k OTE", "$160k–$200k OTE", "Open to discuss"] },
  { label: "Visa sponsorship", question: "Does this role offer visa sponsorship?", choices: ["Sponsorship available", "No sponsorship", "Flag for review"] },
  { label: "Relevant companies", question: "Which past companies or types of companies matter most?", choices: ["PropTech SaaS", "Real estate operators", "No company preference"] },
]
// ponytail: Keyword chips only guide this demo; replace them with parsed criteria when the sourcing API is connected.
function followupChoices(index: number, description: string) {
  if (description === SAMPLE_JD) return FOLLOWUPS[index].choices
  if (index === 0) {
    if (/remote/i.test(description)) return ["Remote · US", "Remote · North America", "Location flexible"]
    const city = /(Los Angeles|New York|San Francisco|Chicago|Austin)/i.exec(description)?.[0]
    return city ? [`${city} · hybrid`, `${city} · on-site`, "Remote · US"] : ["Hybrid · location open", "On-site · location open", "Remote · US"]
  }
  if (index === 1 && !/(sales|account executive|business development)/i.test(description)) return ["$120k–$160k base", "$160k–$200k base", "Open to discuss"]
  if (index === 3 && !/(property|real estate|proptech|multifamily)/i.test(description)) return ["B2B SaaS", "Relevant industry", "No company preference"]
  return FOLLOWUPS[index].choices
}
const SAMPLE_ANSWERS = ["Los Angeles · hybrid", "$120k–$160k OTE", "Flag for review", "PropTech SaaS"]
const AXES: { value: ScoreAxis; label: string }[] = [
  { value: "overall", label: "Best match" },
  { value: "experience", label: "Experience" },
  { value: "skills", label: "Skills" },
  { value: "location", label: "Location" },
  { value: "compensation", label: "Compensation" },
]
const START_STEPS: SequenceStep[] = [
  { subject: "A role that connects property operations and SaaS", body: "Hi {{first_name}},\n\nYour work at {{current_company}} stood out. We're speaking with account executives who know how property teams buy software.\n\nWould you be open to a short conversation about a Senior Account Executive opportunity?\n\nBest,\n{{sender_name}}", wait: "Day 0" },
  { subject: "A little more context", body: "Hi {{first_name}},\n\nFollowing up with a bit more context on the team and the property operations platform. Your experience at {{current_company}} looks especially relevant.\n\nOpen to a quick introduction this week?", wait: "Day 4" },
  { subject: "Closing the loop", body: "Hi {{first_name}},\n\nI'll close the loop for now. If the timing changes, I'd be glad to share the role brief.\n\nBest,\n{{sender_name}}", wait: "Day 8" },
]

export default function SourcingStudioDemo() {
  const [view, setView] = useState<View>("results")
  const [roleName, setRoleName] = useState("Senior Account Executive")
  const [jobDescription, setJobDescription] = useState(SAMPLE_JD)
  const [draft, setDraft] = useState("")
  const [searchText, setSearchText] = useState(SAMPLE_JD)
  const [mode, setMode] = useState<"fast" | "deep">("fast")
  const [answers, setAnswers] = useState(SAMPLE_ANSWERS)
  const [step, setStep] = useState(0)
  const [chat, setChat] = useState<ChatLine[]>([])
  const [sort, setSort] = useState<ScoreAxis>("overall")
  const [layout, setLayout] = useState<"cards" | "table">("cards")
  const [criteriaOpen, setCriteriaOpen] = useState(false)
  const [selected, setSelected] = useState<string[]>([])
  const [profile, setProfile] = useState<Candidate | null>(null)
  const [profileTab, setProfileTab] = useState<"experience" | "match" | "notes">("experience")
  const [noteDraft, setNoteDraft] = useState("")
  const [notes, setNotes] = useState<Record<string, string[]>>({})
  const [copyState, setCopyState] = useState<"idle" | "copied" | "unavailable">("idle")
  const [steps, setSteps] = useState<SequenceStep[]>(START_STEPS)
  const [activeStep, setActiveStep] = useState(0)
  const [staged, setStaged] = useState(false)
  const [replyCandidateId, setReplyCandidateId] = useState<string | null>(null)
  const [inviteCandidateId, setInviteCandidateId] = useState<string | null>(null)
  const [weekOffset, setWeekOffset] = useState(0)
  const [selectedSlot, setSelectedSlot] = useState("Wed 7 · 10:00 AM")
  const [invitationPreview, setInvitationPreview] = useState(false)

  // ponytail: Every role uses the same five sample profiles; replace this set with Autumn results at integration time.
  const ranked = useMemo(() => rankCandidates(CANDIDATES, sort), [sort])
  const selectedProfiles = CANDIDATES.filter((candidate) => selected.includes(candidate.id))
  const visibleProfiles = view === "shortlist" ? ranked.filter((candidate) => selected.includes(candidate.id)) : ranked
  const replyCandidate = CANDIDATES.find((candidate) => candidate.id === replyCandidateId)
  const inviteCandidate = CANDIDATES.find((candidate) => candidate.id === inviteCandidateId)
  const weekStart = new Date(2026, 9, 5 + weekOffset * 7)
  const weekDays = Array.from({ length: 5 }, (_, index) => {
    const date = new Date(weekStart)
    date.setDate(weekStart.getDate() + index)
    return `${date.toLocaleDateString("en-US", { weekday: "short" })} ${date.getDate()}`
  })
  const weekEnd = new Date(weekStart.getFullYear(), weekStart.getMonth(), weekStart.getDate() + 4)
  const weekLabel = `${weekStart.toLocaleDateString("en-US", { month: "long" })} ${weekStart.getDate()} – ${weekEnd.getDate()}, ${weekEnd.getFullYear()}`

  function openNewRole() {
    setView("new")
    setDraft("")
    setMode("fast")
    setProfile(null)
  }

  function beginBrief(description: string, searchMode = mode) {
    const text = description.trim()
    if (!text) return
    setJobDescription(text)
    setSearchText(text)
    const customTitle = text.replace(/^We are hiring (a|an)\s+/i, "").split(/\s+(?:to|in|based|with)\b/i)[0].trim()
    setRoleName(text === SAMPLE_JD ? "Senior Account Executive" : customTitle.length <= 45 ? customTitle : "Custom role")
    setAnswers(["", "", "", ""])
    setSelected([])
    setStaged(false)
    setSteps(START_STEPS)
    setActiveStep(0)
    setCriteriaOpen(false)
    setReplyCandidateId(null)
    setInviteCandidateId(null)
    setWeekOffset(0)
    setSelectedSlot("Wed 7 · 10:00 AM")
    setInvitationPreview(false)
    setStep(0)
    setChat([
      { sender: "Scout", text: "I have the job description. I'll clarify four details before showing the sample candidate workspace." },
      { sender: "Scout", text: FOLLOWUPS[0].question },
    ])
    setView(searchMode === "fast" ? "results" : "brief")
  }

  function answerFollowup(value: string) {
    const text = value.trim()
    if (!text || step >= FOLLOWUPS.length) return
    setAnswers((current) => current.map((answer, index) => index === step ? text : answer))
    const next = step + 1
    setChat((current) => [
      ...current,
      { sender: "You", text },
      { sender: "Scout", text: next < FOLLOWUPS.length ? FOLLOWUPS[next].question : "Brief complete. The sample profiles are ready to review." },
    ])
    setStep(next)
    if (next === FOLLOWUPS.length) setView("results")
  }

  function refineBrief() {
    setStep(0)
    setChat([
      { sender: "Scout", text: "Let's refine the search. Your answers will appear in the brief as you go." },
      { sender: "Scout", text: FOLLOWUPS[0].question },
    ])
    setView("brief")
    setProfile(null)
  }

  function toggleShortlist(id: string) {
    setSelected((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id])
    setStaged(false)
  }

  function showProfile(candidate: Candidate) {
    setProfile(candidate)
    setProfileTab("experience")
    setCopyState("idle")
  }

  function copyProfileLink(candidate: Candidate) {
    if (!navigator.clipboard?.writeText) {
      setCopyState("unavailable")
      return
    }
    void navigator.clipboard.writeText("https://www." + candidate.linkedin)
      .then(() => setCopyState("copied"))
      .catch(() => setCopyState("unavailable"))
  }

  function updateStep(field: keyof SequenceStep, value: string) {
    setSteps((current) => current.map((item, index) => index === activeStep ? { ...item, [field]: value } : item))
    setStaged(false)
  }

  function addNote() {
    if (!profile || !noteDraft.trim()) return
    setNotes((current) => ({ ...current, [profile.id]: [...(current[profile.id] || []), noteDraft.trim()] }))
    setNoteDraft("")
  }

  function navigate(next: View) {
    setView(next)
    setProfile(null)
  }

  return (
    <div className="hire">
      <aside className="hire-sidebar" aria-label="Recruiting navigation">
        <div className="hire-brand-row">
          <button className="hire-brand" type="button" onClick={() => navigate("results")} aria-label="Scout home"><span className="hire-brand-mark">◇</span><span>Scout<span className="hire-brand-dot">.</span></span></button>
          <PanelLeft className="hire-sidebar-collapse" size={17} aria-hidden="true" />
        </div>
        <nav className="hire-nav">
          <button type="button" className={view === "new" ? "active" : ""} onClick={openNewRole}><PlusCircle size={18} />New Role</button>
          <button type="button" className={view === "brief" ? "active" : ""} onClick={refineBrief}><FolderOpen size={18} />Job Brief</button>
          <button type="button" className={view === "shortlist" ? "active" : ""} onClick={() => navigate("shortlist")}><Bookmark size={18} />Shortlist{selected.length > 0 && <span className="hire-nav-count">{selected.length}</span>}</button>
          <button type="button" className={view === "sequence" ? "active" : ""} onClick={() => navigate("sequence")}><Send size={18} />Sequence</button>
          <button type="button" className={view === "inbox" ? "active" : ""} onClick={() => navigate("inbox")}><Inbox size={18} />Inbox{replyCandidate && <span className="hire-nav-count">1</span>}</button>
          <button type="button" className={view === "interview" ? "active" : ""} onClick={() => navigate("interview")}><CalendarDays size={18} />Interview</button>
        </nav>
        <div className="hire-role-nav">
          <span>ALL ROLES</span>
          <button type="button" className={view === "results" ? "active" : ""} onClick={() => navigate("results")}><span className="hire-role-dot" />{roleName}</button>
        </div>
        <div className="hire-sidebar-bottom">
          <button type="button" className={view === "workflow" ? "active" : ""} onClick={() => navigate("workflow")}><WandSparkles size={17} />Recruiting workflow</button>
          <div className="hire-demo-status"><span className="hire-demo-dot" /> Interactive prototype · Sample data</div>
          <div className="hire-user"><span>A</span><div><strong>Admin WeKruit</strong><small>Scout workspace</small></div></div>
        </div>
      </aside>

      <main className="hire-main">
        {view === "new" && <div className="hire-new">
          <div className="hire-new-inner">
            <h1>Who are you looking for?</h1>
            <div className="hire-composer">
              <textarea aria-label="Job description" value={draft} onChange={(event) => setDraft(event.target.value)} placeholder="Start with a role title or paste a job description…" />
              <div className="hire-composer-actions"><span className="hire-add-placeholder"><Plus size={19} /></span><div className="hire-mode" role="group" aria-label="Search mode"><button type="button" className={mode === "fast" ? "active" : ""} onClick={() => setMode("fast")}>Fast Search</button><button type="button" className={mode === "deep" ? "active" : ""} onClick={() => setMode("deep")}><Search size={13} />Deep</button></div><button type="button" className="hire-black-button" disabled={!draft.trim()} onClick={() => beginBrief(draft)}>{mode === "deep" ? "Continue" : "Search"} <ArrowRight size={15} /></button></div>
              <div className="hire-composer-foot"><Sparkles size={17} /><div><strong>{mode === "deep" ? "Deep Search" : "Fast Search"}</strong><span>{mode === "deep" ? "Clarify the requirements with a short chat before reviewing candidates." : "Explore the sample talent market now, then refine the brief."}</span></div></div>
            </div>
            <div className="hire-examples"><p>Try an example</p><div><button type="button" onClick={() => { setDraft(SAMPLE_JD); setMode("deep") }}><span>SALES</span><strong>Senior Account Executive</strong><small>Los Angeles · PropTech SaaS · multifamily buyers</small></button><button type="button" onClick={() => { setDraft("We are hiring a Senior Product Manager to build a B2B workflow platform. The role is based in New York and requires 5+ years of product experience."); setMode("deep") }}><span>PRODUCT</span><strong>Senior Product Manager</strong><small>New York · B2B workflows · 5+ years</small></button><button type="button" onClick={() => { setDraft("We are hiring a GTM Engineer with Python, CRM, and outbound automation experience. Remote in the US."); setMode("deep") }}><span>GTM</span><strong>GTM Engineer</strong><small>Remote US · Python · CRM automation</small></button></div></div>
            <div className="hire-how"><strong>How Scout works</strong><span>1 &nbsp; Describe the role</span><ArrowRight size={13} /><span>2 &nbsp; Review candidates</span><ArrowRight size={13} /><span>3 &nbsp; Plan outreach</span></div>
          </div>
        </div>}

        {view === "brief" && <div className="hire-brief-view">
          <div className="hire-brief-top"><div><span className="hire-eyebrow">JOB BRIEF</span><h1>Let's define the search.</h1><p>Four short questions make the candidate review more useful.</p></div><button type="button" className="hire-outline-button" onClick={() => navigate("results")}>View sample results <ArrowRight size={15} /></button></div>
          <div className="hire-progress"><span className="active">Describe role</span><i /><span className="active">Clarify</span><i /><span>Find candidates</span><i /><span>Outreach</span><i /><span>Interview</span></div>
          <div className="hire-brief-grid">
            <section className="hire-chat-panel" aria-label="Clarification chat">
              <div className="hire-panel-heading"><Sparkles size={18} /><div><strong>Scout</strong><span>Recruiting assistant</span></div><small>{Math.min(step + 1, FOLLOWUPS.length)} / {FOLLOWUPS.length}</small></div>
              <div className="hire-chat-kit"><MainContainer><ChatContainer><MessageList>{chat.map((line, index) => <Message key={index} model={{ message: line.text, sender: line.sender, direction: line.sender === "You" ? "outgoing" : "incoming", position: "single" }} />)}</MessageList>{step < FOLLOWUPS.length && <MessageInput key={step} placeholder="Type your answer…" attachButton={false} onSend={(value: string) => answerFollowup(value)} />}</ChatContainer></MainContainer></div>
              {step < FOLLOWUPS.length && <div className="hire-chat-choices">{followupChoices(step, jobDescription).map((choice) => <button type="button" key={choice} onClick={() => answerFollowup(choice)}>{choice}</button>)}<button type="button" onClick={() => answerFollowup("Not specified · review later")}>Skip</button></div>}
            </section>
            <section className="hire-live-criteria"><div className="hire-panel-heading"><SlidersHorizontal size={18} /><div><strong>Search Criteria</strong><span>Updated as you answer</span></div></div><p className="hire-jd-summary">{jobDescription}</p>{FOLLOWUPS.map((item, index) => <div className="hire-criterion-row" key={item.label}><span>{item.label}</span><strong className={answers[index] ? "" : "missing"}>{answers[index] || "Not specified"}</strong></div>)}<div className="hire-source-hint"><Check size={15} /> Candidate evidence and unclear fields appear in the result review.</div></section>
          </div>
        </div>}

        {(view === "results" || view === "shortlist") && <div className="hire-results-view">
          {view === "results" ? <><div className="hire-search-box"><Search size={18} /><input aria-label="Search description" value={searchText} onChange={(event) => setSearchText(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter") beginBrief(searchText, "deep") }} /><button type="button" disabled={!searchText.trim()} onClick={() => beginBrief(searchText, "deep")}>Search</button></div><div className="hire-criteria-line"><span className="hire-criteria-chip">{roleName}</span>{answers[0] && <span className="hire-criteria-chip">{answers[0]}</span>}{answers[3] && <span className="hire-criteria-chip">{answers[3]}</span>}<button type="button" className="hire-criteria-more" onClick={() => setCriteriaOpen(!criteriaOpen)}>{criteriaOpen ? "Hide" : "+2 more"}</button><button type="button" className="hire-text-button" onClick={refineBrief}>Edit</button></div>{criteriaOpen && <div className="hire-criteria-popover">{FOLLOWUPS.map((item, index) => <div key={item.label}><span>{item.label}</span><strong>{answers[index] || "Not specified"}</strong></div>)}</div>}</> : <div className="hire-section-header"><span className="hire-eyebrow">SHORTLIST</span><h1>People worth a closer look.</h1><p>{selectedProfiles.length} candidate{selectedProfiles.length === 1 ? "" : "s"} selected for this role.</p></div>}
          {jobDescription !== SAMPLE_JD && <div className="hire-fixed-data-note">Workflow preview: these five candidate cards and scores are the fixed Senior Account Executive sample. They are not generated from this job description.</div>}
          <div className="hire-results-toolbar"><label className="hire-select-all"><input type="checkbox" aria-label="Select all visible candidates" checked={visibleProfiles.length > 0 && visibleProfiles.every((candidate) => selected.includes(candidate.id))} onChange={(event) => { setSelected(event.target.checked ? Array.from(new Set([...selected, ...visibleProfiles.map((candidate) => candidate.id)])) : selected.filter((id) => !visibleProfiles.some((candidate) => candidate.id === id))); setStaged(false) }} /><span><strong>{view === "results" ? "5 candidate profiles" : selectedProfiles.length + " shortlisted"}</strong><small>Illustrative sample profiles · no live sourcing</small></span></label><div className="hire-toolbar-actions"><label className="hire-sort"><SlidersHorizontal size={15} /><select aria-label="Rank candidates by" value={sort} onChange={(event) => setSort(event.target.value as ScoreAxis)}>{AXES.map((axis) => <option key={axis.value} value={axis.value}>{axis.label}</option>)}</select></label><div className="hire-view-toggle" role="group" aria-label="Result view"><button type="button" className={layout === "cards" ? "active" : ""} onClick={() => setLayout("cards")}><LayoutGrid size={15} />Cards</button><button type="button" className={layout === "table" ? "active" : ""} onClick={() => setLayout("table")}><List size={15} />Table</button></div><button type="button" className="hire-deep-button" onClick={refineBrief}><Sparkles size={15} />Refine in chat</button></div></div>
          {visibleProfiles.length === 0 ? <div className="hire-empty"><Bookmark size={32} /><h2>Your shortlist is empty</h2><p>Open a candidate profile or use the bookmark control on a result card.</p><button type="button" className="hire-black-button" onClick={() => navigate("results")}>Explore candidates <ArrowRight size={15} /></button></div> : layout === "cards" ? <div className="hire-card-grid">{visibleProfiles.map((candidate) => <article className="hire-candidate-card" key={candidate.id}><div className="hire-card-top"><input type="checkbox" aria-label={"Select " + candidate.name} checked={selected.includes(candidate.id)} onChange={() => toggleShortlist(candidate.id)} /><button type="button" className="hire-candidate-identity" onClick={() => showProfile(candidate)}><span className={"hire-avatar " + candidate.color}>{candidate.initials}</span><span><strong>{candidate.name}</strong><small>{candidate.location}</small></span></button><span className="hire-match-score">{scoreCandidate(candidate)}% match</span></div><button type="button" className="hire-card-history" onClick={() => showProfile(candidate)}><span><BriefcaseBusiness size={16} /><strong>{candidate.role} <em>|</em> {candidate.company}</strong><small>Present</small></span><span><i className="hire-timeline-dot" /><strong>{candidate.previous[0]}</strong><small>Previous</small></span><span><GraduationCap size={16} /><strong>{candidate.skillsList.slice(0, 2).join(" · ")}</strong></span></button><div className="hire-card-evidence"><Sparkles size={13} /><p>{candidate.summary}</p></div><div className="hire-card-actions"><button type="button" onClick={() => toggleShortlist(candidate.id)} aria-label={(selected.includes(candidate.id) ? "Remove " : "Add ") + candidate.name + " shortlist"}><Bookmark size={16} fill={selected.includes(candidate.id) ? "currentColor" : "none"} />{selected.includes(candidate.id) ? "Shortlisted" : "Shortlist"}</button><button type="button" onClick={() => { if (!selected.includes(candidate.id)) toggleShortlist(candidate.id); navigate("sequence") }}><Mail size={15} />Email draft</button><button type="button" aria-label={"View " + candidate.name} onClick={() => showProfile(candidate)}><ArrowRight size={16} /></button></div></article>)}</div> : <div className="hire-table-wrap"><table className="hire-table"><thead><tr><th>Candidate</th><th>Current role</th><th>Company</th><th>Location</th><th>Match</th><th>Shortlist</th></tr></thead><tbody>{visibleProfiles.map((candidate) => <tr key={candidate.id}><td><button type="button" onClick={() => showProfile(candidate)}><span className={"hire-avatar " + candidate.color}>{candidate.initials}</span><strong>{candidate.name}</strong></button></td><td>{candidate.role}</td><td>{candidate.company}</td><td>{candidate.location}</td><td><strong>{scoreCandidate(candidate)}%</strong><small>{candidate.summary}</small></td><td><button type="button" onClick={() => toggleShortlist(candidate.id)}><Bookmark size={17} fill={selected.includes(candidate.id) ? "currentColor" : "none"} /></button></td></tr>)}</tbody></table></div>}
          <div className="hire-results-bottom"><span>Match score is a fixed demo weighting: experience 45%, skills 30%, location 15%, compensation 10%.</span><button type="button" onClick={() => navigate("sequence")}>Build a sequence <ArrowRight size={14} /></button></div>
        </div>}

        {view === "sequence" && <div className="hire-standard-view"><div className="hire-section-header"><span className="hire-eyebrow">OUTREACH</span><h1>Sequence</h1><p>Write once, personalize per candidate, review the batch. Nothing sends from this demo.</p></div>{jobDescription !== SAMPLE_JD && <div className="hire-fixed-data-note">Outreach recipients and message templates are still the fixed Senior Account Executive sample. Edit the drafts to explore this workflow.</div>}<div className="hire-sequence-stats"><div><strong>{selectedProfiles.length}</strong><span>Recipients</span></div><div><strong>{steps.length}</strong><span>Steps</span></div><div><strong>{staged ? "Ready" : "Draft"}</strong><span>Review status</span></div></div><div className="hire-sequence-layout"><section className="hire-step-list"><div className="hire-subheading"><strong>Steps</strong><button type="button" onClick={() => { setSteps((current) => [...current, { subject: "", body: "", wait: "Day " + (current.length * 4) }]); setActiveStep(steps.length); setStaged(false) }}><Plus size={15} />Add step</button></div>{steps.map((item, index) => <button type="button" key={index} className={activeStep === index ? "active" : ""} onClick={() => setActiveStep(index)}><span className="hire-step-number">{index + 1}</span><span><strong>{index === 0 ? "Initial email" : "Follow-up email"}</strong><small>{item.wait} · {item.subject || "Untitled draft"}</small></span><ChevronRight size={16} /></button>)}<div className="hire-recipient-list"><strong>Recipients</strong>{selectedProfiles.length ? selectedProfiles.map((candidate) => <span key={candidate.id}><span className={"hire-avatar " + candidate.color}>{candidate.initials}</span>{candidate.name}<small>Email unverified</small></span>) : <p>No one shortlisted yet.</p>}<button type="button" onClick={() => navigate("results")}>Add candidates <ArrowRight size={14} /></button></div></section><section className="hire-step-editor"><div className="hire-subheading"><strong>Step {activeStep + 1} · Email draft</strong>{activeStep > 0 ? <button type="button" onClick={() => { setSteps((current) => current.filter((_, index) => index !== activeStep)); setActiveStep(activeStep - 1); setStaged(false) }}><X size={14} />Remove step</button> : <span>{steps[activeStep].wait}</span>}</div><label>Subject<input value={steps[activeStep].subject} onChange={(event) => updateStep("subject", event.target.value)} /></label><div className="hire-merge-fields"><span>Personalize with</span><button type="button" onClick={() => updateStep("body", steps[activeStep].body + "{{first_name}}")}>First Name</button><button type="button" onClick={() => updateStep("body", steps[activeStep].body + "{{current_company}}")}>Current Company</button></div><label>Message<textarea value={steps[activeStep].body} onChange={(event) => updateStep("body", event.target.value)} /></label><div className="hire-step-editor-foot"><label><Clock3 size={14} />Send on day <input aria-label="Send on day" type="number" min="0" max="365" value={Number(steps[activeStep].wait.replace("Day ", ""))} onChange={(event) => updateStep("wait", "Day " + event.target.value)} /></label><button type="button" className="hire-black-button" disabled={!selectedProfiles.length || staged || steps.some((item) => !item.subject.trim() || !item.body.trim())} onClick={() => setStaged(true)}>{staged ? "Batch staged for review" : "Stage batch for review"} <ArrowRight size={15} /></button></div>{steps.some((item) => !item.subject.trim() || !item.body.trim()) && <p className="hire-step-warning">Complete every step subject and message before staging.</p>}{staged && <div className="hire-stage-confirm"><Check size={16} /><span>Review draft ready for {selectedProfiles.length} candidate{selectedProfiles.length === 1 ? "" : "s"}. Email availability and suppression would be checked before any real send.</span><button type="button" onClick={() => { setReplyCandidateId(selectedProfiles[0].id); navigate("inbox") }}>Simulate an interested reply <ArrowRight size={14} /></button></div>}</section></div></div>}

        {view === "inbox" && <div className="hire-standard-view"><div className="hire-section-header"><span className="hire-eyebrow">CONVERSATIONS</span><h1>Inbox</h1><p>Replies and next steps for this role.</p></div>{replyCandidate ? <div className="hire-inbox-layout"><div className="hire-inbox-list"><span className="hire-inbox-filter">All conversations <strong>1</strong></span><div className="hire-inbox-active"><span className={"hire-avatar " + replyCandidate.color}>{replyCandidate.initials}</span><span><strong>{replyCandidate.name}</strong><small>Interested in learning more</small></span></div></div><div className="hire-inbox-thread"><div className="hire-subheading"><strong>{replyCandidate.name}</strong><span>Sample reply · no message sent</span></div><div className="hire-reply-bubble">Thanks for reaching out. The role sounds interesting—I'd be open to a short conversation to learn more.</div><div className="hire-inbox-next"><strong>Suggested next step</strong><p>Offer a first interview slot and confirm the candidate's interest.</p><button type="button" className="hire-black-button" onClick={() => { setInviteCandidateId(replyCandidate.id); navigate("interview") }}>Plan interview <ArrowRight size={15} /></button></div></div></div> : <div className="hire-empty"><Inbox size={34} /><h2>No replies in this demo yet</h2><p>Stage a sequence, then simulate an interested reply to explore the inbox flow.</p><button type="button" className="hire-black-button" onClick={() => navigate("sequence")}>Open sequence <ArrowRight size={15} /></button></div>}</div>}

        {view === "interview" && <div className="hire-standard-view"><div className="hire-section-header"><span className="hire-eyebrow">SCHEDULING</span><h1>Interview</h1><p>Choose a slot for a candidate who has replied and opted in.</p></div><div className="hire-calendar-top"><div><button type="button" aria-label="Previous week" onClick={() => { setWeekOffset((value) => value - 1); setSelectedSlot(""); setInvitationPreview(false) }}><ChevronLeft size={16} /></button><strong>{weekLabel}</strong><button type="button" aria-label="Next week" onClick={() => { setWeekOffset((value) => value + 1); setSelectedSlot(""); setInvitationPreview(false) }}><ChevronRight size={16} /></button></div><span>Pacific Time · 30 minutes</span></div><div className="hire-calendar"><div className="hire-calendar-corner">GMT−7</div>{weekDays.map((day) => <strong key={day}>{day}</strong>)}{["9:00 AM", "10:00 AM", "11:00 AM", "1:00 PM", "2:00 PM"].map((time) => <div className="hire-calendar-row" key={time}><span>{time}</span>{weekDays.map((day) => <button type="button" className={selectedSlot === day + " · " + time ? "selected" : ""} key={day} onClick={() => { setSelectedSlot(day + " · " + time); setInvitationPreview(false) }} aria-label={"Select " + day + " " + time}>{selectedSlot === day + " · " + time && <span>Selected</span>}</button>)}</div>)}</div><div className="hire-interview-foot"><label>Candidate<select value={inviteCandidateId || ""} onChange={(event) => { setInviteCandidateId(event.target.value || null); setInvitationPreview(false) }}><option value="">Choose a shortlisted candidate</option>{selectedProfiles.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.name}</option>)}</select></label><div><span>Selected slot <strong>{selectedSlot || "Choose a time"}</strong></span><button type="button" className="hire-black-button" disabled={!inviteCandidate || !selectedSlot} onClick={() => setInvitationPreview(true)}>Preview invitation <ArrowRight size={15} /></button></div></div>{invitationPreview && inviteCandidate && <div className="hire-invite-preview"><Check size={17} /><span><strong>Invitation draft for {inviteCandidate.name}</strong><small>{selectedSlot} · 30-minute first conversation. No calendar event was created.</small></span></div>}</div>}

        {view === "workflow" && <div className="hire-standard-view"><div className="hire-section-header"><span className="hire-eyebrow">OPERATING PLAYBOOK</span><h1>From brief to first conversation.</h1><p>A visible recruiting path for the demo.</p></div><div className="hire-workflow-list">{[
          ["01", "Define the role", "Paste the job description, then clarify location, pay, visa, and relevant company background.", "new"],
          ["02", "Find and explain", "Review structured candidate fields, LinkedIn URL, company context, and match evidence.", "results"],
          ["03", "Curate a shortlist", "Choose candidates who deserve a human review before outreach.", "shortlist"],
          ["04", "Review outreach", "Edit email steps, stage the batch, and verify reachability before any real send.", "sequence"],
          ["05", "Book the conversation", "Use an interested reply to prepare a first interview slot.", "interview"],
        ].map(([number, title, detail, target]) => <button type="button" key={number} onClick={() => navigate(target as View)}><span>{number}</span><div><strong>{title}</strong><p>{detail}</p></div><ArrowRight size={18} /></button>)}</div></div>}
      </main>

      {profile && <div className="hire-drawer-layer"><aside className="hire-profile" role="dialog" aria-modal="true" aria-label={profile.name + " profile"}><div className="hire-profile-top"><strong>Profile</strong><div><button type="button" aria-label="Previous candidate" onClick={() => { const index = ranked.findIndex((candidate) => candidate.id === profile.id); showProfile(ranked[(index - 1 + ranked.length) % ranked.length]) }}><ChevronLeft size={18} /></button><button type="button" aria-label="Next candidate" onClick={() => { const index = ranked.findIndex((candidate) => candidate.id === profile.id); showProfile(ranked[(index + 1) % ranked.length]) }}><ChevronRight size={18} /></button><button type="button" aria-label="Close profile" onClick={() => setProfile(null)}><X size={19} /></button></div></div><div className="hire-profile-scroll"><div className="hire-profile-identity"><span className={"hire-avatar " + profile.color}>{profile.initials}</span><div><h2>{profile.name}</h2><p>{profile.role} at {profile.company}</p><small><MapPin size={13} />{profile.location}</small></div><span className="hire-profile-score">{scoreCandidate(profile)}%<small>match</small></span></div><div className="hire-profile-link"><span>LinkedIn</span><code>{profile.linkedin}</code><button type="button" aria-label="Copy sample LinkedIn URL" onClick={() => copyProfileLink(profile)}>{copyState === "copied" ? <Check size={15} /> : <Copy size={15} />}</button><small role="status">{copyState === "copied" ? "Copied" : copyState === "unavailable" ? "Copy unavailable" : ""}</small></div><div className="hire-contact-strip"><Mail size={16} /><span>Email unavailable in sample data</span><button type="button" onClick={() => { if (!selected.includes(profile.id)) toggleShortlist(profile.id); setProfile(null); setView("sequence") }}>Draft email</button></div><div className="hire-profile-actions"><button type="button" className="hire-black-button" onClick={() => { if (!selected.includes(profile.id)) toggleShortlist(profile.id); setProfile(null); setView("sequence") }}><Send size={15} />Email draft</button><button type="button" className="hire-outline-button" onClick={() => toggleShortlist(profile.id)}><Bookmark size={15} fill={selected.includes(profile.id) ? "currentColor" : "none"} />{selected.includes(profile.id) ? "Shortlisted" : "Shortlist"}</button></div><div className="hire-profile-tabs">{(["experience", "match", "notes"] as const).map((tab) => <button type="button" key={tab} className={profileTab === tab ? "active" : ""} onClick={() => setProfileTab(tab)}>{tab === "match" ? "Match & company" : tab === "notes" ? "Notes" : "Experience"}</button>)}</div>{profileTab === "experience" && <div className="hire-profile-body"><h3>Work Experience</h3><div className="hire-experience-row"><span className="hire-company-icon">{profile.company[0]}</span><div><strong>{profile.role}</strong><p>{profile.company} · {profile.companyDetail}</p><small>Present · {profile.years}</small></div></div>{profile.previous.map((company, index) => <div className="hire-experience-row" key={company}><span className="hire-company-icon secondary">{company[0]}</span><div><strong>{index === 0 ? "Previous sales role" : "Earlier experience"}</strong><p>{company}</p><small>Sample record</small></div></div>)}<h3>Skills</h3><div className="hire-skill-list">{profile.skillsList.map((skill) => <span key={skill}>{skill}</span>)}</div></div>}{profileTab === "match" && <div className="hire-profile-body"><div className="hire-match-explanation"><Sparkles size={17} /><p>{profile.summary}</p></div><h3>Why this person appears</h3>{[["Relevant experience", profile.experience], ["Skills overlap", profile.skills], ["Location fit", profile.locationFit], ["Compensation fit", profile.compensationFit]].map(([label, value]) => <div className="hire-match-axis" key={label}><span>{label}</span><strong>{value}%</strong><i><i style={{ width: String(value) + "%" }} /></i></div>)}<div className="hire-unclear"><span>UNCLEAR</span> Visa status is not present in the sample profile. Confirm directly.</div><h3>Current company</h3><div className="hire-company-card"><span className="hire-company-icon">{profile.company[0]}</span><div><strong>{profile.company}</strong><p>{profile.companyDetail}</p><small>{profile.companySize} · HQ {profile.companyHQ}</small></div></div><p className="hire-data-note">Illustrative sample profile. A connected Autumn result should show source links for each field.</p></div>}{profileTab === "notes" && <div className="hire-profile-body"><h3>Recruiting notes</h3><textarea aria-label="Candidate note" placeholder="Add a note for this candidate…" value={noteDraft} onChange={(event) => setNoteDraft(event.target.value)} /><button type="button" className="hire-black-button" onClick={addNote}>Add note <Plus size={15} /></button>{(notes[profile.id] || []).map((item, index) => <p className="hire-note" key={index}>{item}</p>)}<div className="hire-note-hint"><MessageCircle size={17} />Notes live in this browser session only.</div></div>}</div></aside></div>}
    </div>
  )
}
