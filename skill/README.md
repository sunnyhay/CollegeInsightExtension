# CollegeInsight Skill for OpenClaw

## Setup

1. Log into [CollegeInsight.ai](https://www.collegeinsight.ai)
2. Go to **Settings → API Access**
3. Click **Generate API Key** and choose scope (Read-only or Read & Write)
4. Copy the key (shown only once)
5. In your terminal, configure OpenClaw:

```bash
openclaw config set skills.entries.college-insight.env.CI_API_KEY "ci_your_key_here"
```

6. Install the skill:

```bash
clawhub install college-insight
```

7. Test the connection:

```
"Check my CollegeInsight profile"
```

## Connect WhatsApp or Discord

You can message your agent from WhatsApp or Discord. All features work on both channels.

### WhatsApp

```bash
openclaw channels login --channel whatsapp
# Scan the QR code with your phone
```

### Discord

1. Create a bot at [Discord Developer Portal](https://discord.com/developers/applications)
2. Enable Message Content Intent on the Bot page
3. Add the bot to your private server
4. Configure:

```bash
openclaw config set channels.discord.token '"YOUR_BOT_TOKEN"' --json
openclaw config set channels.discord.enabled true --json
```

5. DM the bot to pair

## Set Up Document Folder

```bash
bash scripts/setup-docs-folder.sh
```

Or tell your agent: **"Set up my college docs folder"**

This creates `~/CollegeInsight/` with subfolders for transcripts, test scores, recommendations, essays, certificates, and financial documents.

## Usage Examples

### Quick Status (WhatsApp / Discord)

- "What's my GPA?"
- "How's my Common App?"
- "Next deadline?"
- "Compare Stanford vs MIT"
- "How many activities do I have?"

### Document Scanning

- "Scan my docs"
- "What docs am I missing?"

### Application Filling

- "Fill my Common App activities"
- "Fill UC Application personal info"

### Essay Brainstorming

- "Help me brainstorm my MIT essay"
- "Continue the essay we discussed"

### Deadline Monitoring

- "What deadlines are coming up?"
- Automatic daily alerts at 8am (when gateway is running)

### College Research

- "Tell me about Stanford"
- "Compare MIT vs Caltech for CS"
- "What's Berkeley's acceptance rate?"

### Scholarship & Opportunities

- "Help me fill this scholarship application" (while on a scholarship page)
- "What scholarships match my profile?"

## Requirements

- Active CollegeInsight.ai account with profile data
- API Key generated from Settings → API Access
- OpenClaw with browser tool installed (`openclaw browser install`)

## Supported Portals

| Portal              | Fill Support | Notes                                  |
| ------------------- | ------------ | -------------------------------------- |
| Common App          | ✅ Full      | Activities, testing, education, essays |
| UC Application      | ✅ Full      | Activities, PIQs, personal info        |
| FAFSA               | ⚠️ Partial   | Demographics only (no financial data)  |
| College Board       | ✅ Full      | Registration, score sends              |
| Scholarship portals | ⚠️ Partial   | Demographics + GPA + activities        |

## Privacy & Safety

- Your portal login credentials are never stored or transmitted to CollegeInsight
- The skill never submits forms without your explicit approval
- Financial fields (income, assets) are never auto-filled
- All data stays between your local machine and CollegeInsight.ai servers
- API Key expires after 90 days — regenerate from Settings if needed
