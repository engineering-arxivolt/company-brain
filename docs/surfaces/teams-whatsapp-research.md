# Teams and WhatsApp frontend research

**Status:** research and decision paper. No implementation has been started.
**Date:** 2026-10-27
**Scope:** add Microsoft Teams and WhatsApp as Company Brain frontends, with
enterprise feature parity and approval-card support.
**Companion docs:** [Slack surface](../slack.md), [architecture](../architecture.md),
[connectors](../guide/connectors.md), [permissions](../guide/permissions.md).

## Short version

- **Teams can become a real second enterprise frontend.** It supports DMs, group
  chats, channels, threads, proactive messages, files, SSO, rich Adaptive Cards,
  and user-specific approval views. The main gaps are channel-scope SSO, tenant
  admin consent, RSC/Graph setup, private/shared-channel edge cases, and the
  amount of adapter work.
- **WhatsApp is a companion surface, not a Slack/Teams replacement.** It is
  excellent for 1:1 notifications and fast approvals. It has no enterprise SSO,
  no channels or threads, no ambient conversation history, no editable sent
  messages, a 24-hour service window, template approval, and a Groups API that
  does not support interactive approval cards.
- **Build Teams first.** Add WhatsApp as a constrained 1:1 companion for
  notifications, simple questions, and approvals. Do not promise WhatsApp
  channel parity or an in-chat app marketplace.
- **The app catalog does not shrink.** Company Brain connectors are shared MCP
  tools, not Slack-specific integrations. Teams and WhatsApp can invoke the same
  catalog. Teams can also approximate Slack's connect/review UX with Adaptive
  Cards and authenticated links. WhatsApp can execute the tools, but connector
  discovery and OAuth need a web link or a Flow.

> **Recommendation:** Teams is the second full frontend. WhatsApp is a
> high-value, deliberately limited surface. Treat those as different product
> commitments, not two equivalent “frontends.”

## 1. What “as many apps as enterprise” means

Company Brain's “apps” are MCP connectors and embedded tools. The catalog lives
in `src/brain/tools/mcp/catalog.ts` and the tool runtime, not in the Slack
renderer. Slack only supplies the surface UX around the tool call.

There are three different kinds of parity:

| Layer | Meaning | Teams | WhatsApp |
|---|---|---|---|
| Catalog parity | The same connectors and actions are available | Yes | Yes |
| Execution parity | The agent can call the connector with the user's identity and permissions | Yes | Yes, once the user is linked |
| Interaction parity | Users can browse, connect, review, approve, and manage apps in-surface | Yes; close to Slack, with some flows linking out | No; needs a web link or Flow |

So the requirement is met if it means: *“Do not remove connectors or make Teams
and WhatsApp second-class tool citizens.”* It is not met if it means: *“Give
WhatsApp the same in-chat app management and rich review cards as Slack.”*
WhatsApp's message model cannot carry that experience.

The design rule should be:

- Connectors remain shared and surface-independent.
- The surface adapter chooses how to display a tool call, a connect prompt, and
  an approval.
- No connector is added only for Slack.
- A surface may degrade the *interaction* without reducing the *catalog*.

## 2. Baseline: what Slack does today

The current product is a Slack-facing agent backed by a Cloudflare Worker, a
Durable Object per Supermemory org, shared memory, and MCP tools. The important
current behaviors are:

- Slack events, OAuth install, Block Kit interactions, and account linking.
- DMs, mentions, bot-owned threads, channel chime/triage, and public-channel
  rollout.
- Streaming answers in DMs; public progress cards in channels.
- Memory writeback scoped by channel privacy.
- Live app tools through MCP connectors.
- Consequential tool calls suspend the turn and post an Approve/Deny card.
- Reactions for feedback, plus a review-card pattern for skills/content.

### 2.1 Current approval invariants

The existing Slack approval path is more than a button renderer. These
invariants must survive the move to any new surface:

1. **Asker-only decision.** `runSlackApprovalDecisionInner` rejects a decision
   when `approval.askerUser !== decision.userId`.
2. **Workspace/installation binding.** The approval belongs to a `teamId`; a
   different workspace cannot decide it.
3. **Pending and unexpired.** The approval must still be `pending` and within
   `APPROVAL_EXPIRY_MS` (15 minutes).
4. **Turn currency.** If the thread was superseded by a newer instruction, the
   approval is cancelled rather than resumed.
5. **Org membership.** The decision identity must still resolve to an active
   member of the org.
6. **One-time decision.** `markApprovalDecided` uses a conditional
   `UPDATE ... WHERE status = 'pending'`; the loser of a race gets “already
   handled.”
7. **Resume integrity.** The persisted resume envelope contains the turn state;
   the card's visible summary is not trusted as the tool input.
8. **Audit and resolution.** The card is rebuilt in a resolved state and the
   interaction response is updated.

### 2.2 What is Slack-specific today

`PendingApproval` currently stores Slack-shaped fields:

```ts
type PendingApproval = {
  approvalId: string
  turnId: string
  orgId: string
  teamId: string
  channel: string
  threadTs: string
  cardTs?: string
  askerUser: string
  toolName: string
  slug?: string
  toolInput: unknown
  summary: string
  state: ApprovalResumeState
  status: ApprovalStatus
  createdAt: number
  expiresAt: number
  decidedAt?: number
  decidedBy?: string
}
```

The core state machine is reusable. The Slack coupling is in:

- `teamId`, `channel`, `threadTs`, and `cardTs` as the conversation reference.
- `askerUser` as the only identity.
- Block Kit rendering in `src/brain/slack/client.ts`.
- Interaction parsing in `src/routes/slack/index.ts`.
- Slack-specific identity lookup and workspace validation.

Those should become surface references and surface identity proofs, not remain
Slack columns with overloaded meanings.

## 3. Capability comparison

### 3.1 Conversation and identity

| Capability | Slack today | Teams | WhatsApp |
|---|---|---|---|
| 1:1 chat | DM | Personal chat | 1:1 chat |
| Group conversation | Group DM / channel | Group chat | Group, with major limits |
| Team/channel workspace | Channels | Channels | None |
| Threads | Thread replies | Channel replies / thread context | None; only quoted replies |
| Ambient all-message ingestion | Events for installed channels | RSC `ChannelMessage.Read.Group` / `ChatMessage.Read.Chat` after owner consent | None |
| @mentions | Yes | Yes | Not applicable |
| Proactive message | `chat.postMessage` | Stored conversation reference + installed app | Template, or free-form inside 24h |
| Native enterprise SSO | Slack OAuth + workspace identity | Entra ID SSO; **not in channel scope** | None |
| Admin install | Workspace admin | Teams tenant admin / org catalog | Meta app + WABA/Messaging account onboarding |
| Account mapping | `(team_id, slack_user_id)` | `(tenant_id, aad_object_id / MRI)` | `(phone, wa_id)` linked to an org user |

Teams' channel SSO limitation is structural, not a configuration gap. Microsoft
documents SSO for bot apps as supported in one-on-one and group chat, and **not
supported in channel scope**. In channels, use `aadObjectId` + tenant ID plus
Graph/RSC resolution, or a link-code flow back to the console.

Teams also receives only @mentions in group chats and channels by default. The
RSC permissions above change that after team/chat-owner consent. This is the
closest Teams analogue to Slack's ambient channel behavior, but it is a
privacy-sensitive permission and should not be requested silently.

### 3.2 Answering and workflow UX

| Capability | Slack today | Teams | WhatsApp |
|---|---|---|---|
| Streaming answer | DM/assistant stream | 1:1 only; one stream per chat; ~1 request/sec | Typing indicator only |
| Progress/task cards | Block Kit progress cards | Adaptive Cards; edits for progress | Plain progress messages; no edit |
| Rich review card with many actions | Block Kit | Adaptive Cards | At most 3 reply buttons; lists/Flows for more structure |
| Approval card | Asker-only Block Kit card | Adaptive Card + `refresh.userIds` + `Action.Execute` | Interactive reply buttons in 1:1; template/Flow outside 24h |
| Resolve a card in place | Interaction response replacement | Edit the original activity | No documented business edit/delete; send follow-up |
| File upload/download | Slack files | Graph/SharePoint/OneDrive in all scopes | Media messages; docs up to 100 MB |
| Reactions / feedback | Reactions + feedback flow | Reactions + AI feedback controls | User reaction webhooks; business can react |
| App connect / OAuth | Block Kit button + OAuth | Adaptive Card link/SSO; per-app OAuth still needed | Link to console/Flow; no in-chat OAuth |
| Connector invocation | Yes | Yes | Yes, after identity link |
| Search/history | Slack search tools | Graph/RSC, scoped by tenant | No channel history; chat-local only |

### 3.3 Enterprise operations

| Capability | Slack today | Teams | WhatsApp |
|---|---|---|---|
| Tenant isolation | Workspace → org | Entra tenant + team/chat installation | Meta app + WABA/Messaging account + phone |
| Admin consent | Workspace install | Tenant app catalog/policy; Graph consents | Meta app review, business verification, asset sharing |
| Data boundary | Slack workspace | Microsoft 365 tenant | Meta Cloud API (Meta is processor) |
| Retention / eDiscovery | Slack controls | Microsoft 365 controls | Meta retention up to 30 days; your own store |
| DLP / sensitivity | Slack + app controls | Microsoft 365 DLP / labels | No equivalent in chat; app-side only |
| Data residency | Slack region | Teams region / GCC options | Meta data centers; Local Storage option |
| Rate limits | Slack tier-based | 7 messages/sec/conversation, 50 RPS/app/tenant, 1,800/hour per conversation | 80 messages/sec/number default, auto-upgradeable |
| Message size | Slack limits | ~100 KB approximate limit; target <80 KB | Text 4,096 chars; interactive body 1,024 chars |
| Pricing | Per seat | Microsoft 365 license + Azure/Bot infrastructure | Per delivered message; 1,000 free service messages/phone/month |
| Distribution | Slack app directory / workspace | Teams org catalog / Teams Store | Meta app + Embedded Signup / WABA |

## 4. Approval cards

### 4.1 State machine

```text
                 approve                  resume ok
  pending ──────────────────► approved ─────────────► executed
     │                           │
     │                           └── resume error ──► error
     ├── deny ──────────────────────────────────────► denied
     ├── expiresAt ─────────────────────────────────► expired
     └── newer instruction / uninstalled ───────────► cancelled
```

`approved` and `denied` are decisions. `executed`, `error`, `expired`, and
`cancelled` are terminal. A decision must be claimable exactly once before the
turn resumes.

### 4.2 Normalized approval model

The minimum generalization is:

```ts
type SurfaceKind = "slack" | "teams" | "whatsapp"

type SurfaceConversationRef = {
  surface: SurfaceKind
  installationId: string
  tenantId?: string          // Slack team, Teams tenant, WhatsApp WABA
  conversationId: string     // channel, Teams conversation, wa_id
  threadId?: string          // Slack thread_ts, Teams replyToId
}

type SurfaceMessageRef = {
  conversation: SurfaceConversationRef
  messageId: string          // Slack ts, Teams activity id, WhatsApp wamid
  canEdit: boolean
}

type SurfaceActorRef = {
  surface: SurfaceKind
  installationId: string
  externalUserId: string     // Slack user, Teams AAD object/MRI, WhatsApp wa_id
  tenantId?: string
}

type SurfaceApprovalPresentation = {
  message: SurfaceMessageRef
  renderVersion: number
  audience: "asker" | "approvers" | "conversation"
  expiresAt: number
}
```

`PendingApproval` should gain a surface/installation/conversation reference and
a decision proof, while keeping the existing turn state and status rules. The
Slack fields can be migrated into the generic reference; they should not be
duplicated forever.

The **decision proof** is surface-specific:

| Surface | Proof | Notes |
|---|---|---|
| Slack | Slack user ID resolved to workspace member | Existing path |
| Teams | Entra `aadObjectId` + tenant, or verified MRI | Validate against the stored asker |
| WhatsApp | `wa_id` mapped to a verified org user | Phone possession is not enterprise SSO |

### 4.3 Teams approval design

Teams has the best approval primitive of the three surfaces.

#### Lifecycle

1. The turn suspends on a consequential tool call; core persists the approval
   with `surface = "teams"` and the originating conversation reference.
2. The adapter resolves the asker's Teams MRI and Entra identity. If there is no
   linked identity, send a link-code card instead of buttons.
3. Post a **base card** with no actions and
   `refresh.userIds = [askerMRI]`. Store `activityId`, `conversationId`,
   `serviceUrl`, and `tenantId`.
4. Teams automatically invokes the bot for the asker to obtain their
   user-specific view. Return the asker card with Approve/Deny buttons only if
   the invoking identity is the asker.
5. The asker clicks Approve/Deny. Teams sends an `adaptiveCard/action` invoke.
   Validate the action verb/data and identity; claim the decision atomically.
6. Return an immediate acknowledgment card (for example, “Approved. Continuing
   in the thread.”). Do the tool resume asynchronously in the Durable Object.
7. Edit the original message to the resolved card. Remove the action buttons.
   If the design later supports multiple approvers, remove only the decided
   approver from `refresh.userIds` and keep the card pending for the rest.
8. On expiry or supersession, edit the card to Expired/Cancelled and mark the
   approval terminal.

The invoke handler must not run the tool inside the response window. A Teams
invoke is short-lived; return quickly and update asynchronously. The tool can
take minutes, and the approval card must remain responsive.

#### Base card

```json
{
  "$schema": "http://adaptivecards.io/schemas/adaptive-card.json",
  "type": "AdaptiveCard",
  "version": "1.5",
  "refresh": {
    "action": {
      "type": "Action.Execute",
      "title": "Refresh",
      "verb": "approval_refresh"
    },
    "userIds": ["<asker-mri>"]
  },
  "body": [
    {
      "type": "TextBlock",
      "weight": "Bolder",
      "text": "Approval required"
    },
    {
      "type": "FactSet",
      "facts": [
        { "title": "Requested by", "value": "Alex" },
        { "title": "Action", "value": "Send email via Gmail" },
        { "title": "Target", "value": "finance@example.com" },
        { "title": "Expires", "value": "in 15 minutes" }
      ]
    },
    {
      "type": "TextBlock",
      "wrap": true,
      "text": "Only the requester can approve or deny this action."
    }
  ]
}
```

The base card has no user-visible actions. Other viewers see a read-only pending
card. The asker gets a user-specific card because their MRI is in
`refresh.userIds`.

Card version 1.5 is required for `refresh` and `Action.Execute`. If older Teams
clients are in the support matrix, add `fallback: Action.Submit` and handle both
actions; otherwise pin the experience to current clients and test the fallback
behavior.

#### Asker card returned by the refresh invoke

```json
{
  "type": "AdaptiveCard",
  "version": "1.5",
  "body": [
    { "type": "TextBlock", "weight": "Bolder", "text": "Approval required" },
    { "type": "TextBlock", "wrap": true, "text": "Send email via Gmail to finance@example.com." },
    { "type": "TextBlock", "wrap": true, "text": "This action will run with your connected Gmail account." }
  ],
  "actions": [
    {
      "type": "Action.Execute",
      "title": "Approve",
      "verb": "approval_decide",
      "data": { "approvalId": "<id>", "decision": "approve" }
    },
    {
      "type": "Action.Execute",
      "title": "Deny",
      "verb": "approval_decide",
      "data": { "approvalId": "<id>", "decision": "deny" }
    }
  ]
}
```

`approvalId` is a random, non-guessable server-side ID. The card `data` can be
tampered with by a custom client, so the server must reload the approval and
validate the status, expiry, actor, installation, and turn currency. The card
must not carry the tool input as authority.

#### Identity and channel behavior

- In personal and group chat, Teams SSO can provide Entra identity.
- In channels, SSO is not supported. Use `aadObjectId` + `tenantId` and verify
  channel membership through Graph or `ChannelMember.Read.Group` RSC, or send
  the user a link-code flow.
- `refresh.userIds` is an array of MRIs; maximum 60. If omitted in a group or
  channel with ≤60 members, Teams auto-refreshes everyone. For asker-only
  approval, always specify the asker explicitly; do not rely on the default.
- The base card is visible to everyone in the conversation. Buttons appear only
  in the asker's user-specific view.
- Store the `activityId`, `serviceUrl`, and conversation reference so the card
  can be edited later. Proactive messages require an installed app and a stored
  conversation reference; `aadObjectId` alone is not enough for group or
  channel delivery.
- Private/shared channel support is evolving. Microsoft's newer channel-support
  docs say agents are supported there, while the channel conversation guide
  still warns that bot messages/Adaptive Cards may not post in private channels.
  Treat private-channel card delivery as a validation gate and fall back to DM
  or group chat when it fails. The app must be added to each shared/private
  channel, and channel membership is not the same as team membership.

#### Resolution and failure

- Approve/Deny: edit the original message to a resolved card; no buttons remain.
- Expiry: a Durable Object alarm updates the card and calls
  `markApprovalTerminal(..., "expired")`. Always validate expiry again on click.
- Supersession: edit the card to Cancelled and do not resume the old turn.
- Duplicate click: return “already handled”; do not run twice.
- App uninstalled/message deleted: log the failed edit, mark the approval
  cancelled or expired, and fall back to DM/console notification.
- Rate limits: retry 429/412/502/504 with jittered exponential backoff; keep
  messages under the ~100 KB limit and target 80 KB.

Teams messages also have strict limits: 7 sends/sec/conversation, 50 RPS per
app per tenant, and 1,800 operations/hour per conversation. Approval updates
must be coalesced, not streamed as many edits.

### 4.4 WhatsApp approval design

WhatsApp has no equivalent of an Adaptive Card or an editable business message.
The approval must be designed around that.

#### Only 1:1

Approval cards must go to the asker's WhatsApp DM, never to a group. The Groups
API requires an Official Business Account, supports at most 8 participants, and
supports only text/media/templates, not interactive messages. A group approval
card is not viable.

#### Inside the 24-hour customer-service window

Use an interactive reply-buttons message. Buttons support up to 3 options,
labels up to 20 characters, and IDs up to 256 characters.

```json
{
  "messaging_product": "whatsapp",
  "recipient_type": "individual",
  "to": "+16505551234",
  "type": "interactive",
  "interactive": {
    "type": "button",
    "header": { "type": "text", "text": "Approval required" },
    "body": {
      "text": "Send email via Gmail to finance@example.com?\n\nExpires 10:42 UTC."
    },
    "footer": { "text": "Company Brain" },
    "action": {
      "buttons": [
        {
          "type": "reply",
          "reply": { "id": "appr:<approvalId>:approve", "title": "Approve" }
        },
        {
          "type": "reply",
          "reply": { "id": "appr:<approvalId>:deny", "title": "Deny" }
        }
      ]
    }
  }
}
```

The relevant part of the webhook is `messages[0]`; it returns the button ID, not
just the label:

```json
{
  "type": "interactive",
  "interactive": {
    "type": "button_reply",
    "button_reply": {
      "id": "appr:<approvalId>:approve",
      "title": "Approve"
    }
  }
}
```

Validate:

- `metadata.phone_number_id` maps to the org installation.
- `contacts[0].wa_id` and `messages[0].from` map to the same verified identity.
- `context.id` is the approval message ID (when present).
- The approval is pending, unexpired, and still current.
- The linked org user is the asker and is still a member.

The 24-hour window opens/resets when the user messages or calls the business.
If the window is open, the interactive message is a service message and can be
sent immediately. If it is closed, only an approved template can reach the user.

#### Outside the 24-hour window

| Pattern | What it requires | Assessment |
|---|---|---|
| Utility template with quick-reply buttons | Approved template; up to 10 buttons; labels ≤25 chars; webhook payload is the label text | Weak for approvals: cannot carry an arbitrary approval ID. Workable only if the label encodes a unique short code, or you enforce one pending approval per user. |
| Utility template with a URL button | Approved template; button opens a signed approval page with SSO | Best enterprise fallback. The WhatsApp message is a notification; the decision and rich context live in the authenticated console. |
| Template with a Flow button | Published Flow; template approval; `flow_token` can carry the approval ID | Powerful, but the Flow template category and review path must be confirmed with Meta. Current utility-template docs list URL/quick-reply/etc., not FLOW. Do not make this the only path. |
| Plain text `APPROVE <code>` | Short, unique code; confirmation outside the window needs a template | Useful as a last resort; not an approval card and easy to confuse with other messages. |

The critical WhatsApp quick-reply trap: for **template** quick replies, the
webhook payload equals the button label text, not a custom payload ID. That is
different from an interactive reply-button message, where the button ID is
preserved. A template cannot embed an arbitrary approval UUID in a quick-reply
payload. Use a signed URL, a Flow token, or a deliberate one-pending/short-code
scheme.

#### Flow option

WhatsApp Flows can present a structured form (decision, comment, confirmation)
inside WhatsApp. Flows are available in-window as an interactive message, and
can be attached to a template for business-initiated messages. Completion
arrives as `interactive.nfm_reply`, with `response_json` containing the Flow
data. The response does **not** include the Flow ID, so the `flow_token` must
carry the approval ID. The relevant part of the webhook is `messages[0]`:

```json
{
  "type": "interactive",
  "interactive": {
    "type": "nfm_reply",
    "nfm_reply": {
      "name": "flow",
      "body": "Sent",
      "response_json": "{\"flow_token\":\"appr:<approvalId>\",\"decision\":\"approve\",\"comment\":\"Looks good\"}"
    }
  }
}
```

Flows require business verification and high message quality. Endpoint-powered
Flows add encryption keys, health monitoring, and latency requirements. For v1,
a Flow is optional; the simple in-window button card is the primary UX.

#### No edit, so resolve with a follow-up

Cloud API has no documented business-side edit/delete endpoint for messages you
send. The edit/revoke webhooks that exist are for WhatsApp Business app
(coexistence) users editing their own messages, not a way to update your
approval card. The original approval card remains visible after a decision. Therefore:

- Send a follow-up message: “Approved by Alex. The action ran.” or “Denied by
  Alex. Nothing ran.”
- Keep the original message immutable; it is an audit artifact, not a live card.
- Validate late button taps: an old button can still generate a webhook after
  expiry or after a decision. Return “already handled” or “expired” and do not
  resume the turn.
- If the decision is made in WhatsApp but the turn originated in Slack/Teams,
  update the originating surface's card as the authoritative resolution.

#### Expiry and delivery

The existing 15-minute expiry is a good security default, but WhatsApp has more
delivery friction than Slack. Consider a per-surface TTL:

- In-window 1:1 approval: 15 minutes by default.
- Template/URL fallback: 30–60 minutes, with the expiry stated in the message.
- Never auto-approve on timeout. Expire and notify the requester.

Track delivery and read statuses from WhatsApp webhooks. If a template fails,
is paused by quality/pacing, or the user has not opted in, fall back to the
console, Slack, or Teams. Do not silently leave an approval pending with no
reachable decision surface.

### 4.5 Approval comparison

| Question | Slack | Teams | WhatsApp |
|---|---|---|---|
| Where is the card? | Thread message | Personal/group/channel message | 1:1 chat message |
| Who sees buttons? | Asker only | Asker only, via user-specific view | The linked user in the 1:1 chat |
| Decision proof | Slack user + workspace member | Entra ID/MRI + tenant member | `wa_id` + verified org link |
| In-place resolution | Interaction response update | Message edit | Follow-up message |
| Group/channel approval | Yes | Yes (private channels need validation) | No; 1:1 only |
| Rich context | Block Kit | Adaptive Cards | Short body + optional URL/Flow |
| Expiry update | Card update | Card edit | Follow-up / no edit |
| Failure fallback | Ephemeral reply | Edit/DM/console | Console/Slack/Teams/email |

## 5. Architecture

### 5.1 Adapter boundary

```text
Slack events ─────┐
Teams activities ─┼──► verify + normalize ──► org/installation router
WhatsApp webhook ─┘                               │
                                                  ▼
                                      CompanyBrainAgent (DO per org)
                                      turns · memory · tools · approvals
                                                  │
                              ┌───────────────────┼───────────────────┐
                              ▼                   ▼                   ▼
                        Slack adapter       Teams adapter       WhatsApp adapter
                        Block Kit           Adaptive Cards      buttons/templates/Flows
```

The core should not import Block Kit, Adaptive Cards, or WhatsApp payload
types. Surface-specific code should live in `src/brain/surfaces/<surface>/` and
the HTTP routes, while the turn/approval core consumes normalized references.

A minimal contract:

```ts
interface SurfaceAdapter {
  surface: SurfaceKind
  capabilities: {
    editMessages: boolean
    adaptiveCards: boolean
    interactiveButtons: boolean
    threads: boolean
    ambientMessages: boolean
    files: boolean
    reactions: boolean
    streaming: boolean
    templates: boolean
  }

  verifyAndParse(request: Request): Promise<InboundEvent[]>
  resolveInstallation(event: InboundEvent): Promise<SurfaceInstallation>
  resolveActor(event: InboundEvent): Promise<SurfaceActor | null>

  send(message: OutboundMessage): Promise<SurfaceMessageRef>
  update?(ref: SurfaceMessageRef, message: OutboundMessage): Promise<void>
  renderApproval(approval: PendingApproval, viewer: SurfaceActor): SurfacePayload
  parseApprovalDecision(event: InboundEvent): ApprovalDecision | null
}
```

`capabilities` lets the agent choose a fallback instead of branching on
`surface === "whatsapp"` everywhere. For example, if `editMessages` is false,
the approval presenter knows it must send a resolution follow-up.

### 5.2 Storage

Keep the deployment's relational D1 database for durable installation/identity
data and Durable Object SQL for turn-local state. Suggested tables:

| Store | Table | Purpose |
|---|---|---|
| D1 | `surface_installation` | surface, external tenant, org, encrypted credentials, scopes, status |
| D1 | `surface_identity` | external user, installation, org/user, verification method, verified_at |
| D1 | `surface_conversation` | external conversation, scope, org, last inbound time, WhatsApp service-window expiry |
| DO SQL | `brain_pending_approval` | add surface, installation, conversation reference, decision proof |
| DO SQL | `brain_approval_presentation` | one row per rendered message; message ID, render version, audience, resolved state |
| KV | `surface:event:{id}` | short-TTL webhook dedupe |

Credentials must use the existing encrypted-token pattern; do not store bot
tokens, Meta tokens, or OAuth refresh tokens in plaintext. Slack's
`slack_workspace` can remain during migration, with a generic
`surface_installation` added alongside it.

### 5.3 Proposed HTTP surface

| Method | Path | Auth | Purpose |
|---|---|---|---|
| POST | `/brain/teams/messages` | Bot Framework JWT | Activities, installs, invokes |
| GET/POST | `/brain/teams/sso` | Teams SSO token | Token exchange / link completion |
| GET | `/brain/whatsapp/webhook` | Verify token | Meta webhook challenge |
| POST | `/brain/whatsapp/webhook` | `X-Hub-Signature-256` | Messages, statuses, template updates |
| GET | `/brain/surfaces/status` | Session | Connected surfaces for an org |
| DELETE | `/brain/surfaces/:surface` | Session + admin | Disconnect an installation |
| GET/POST | `/brain/surfaces/link/:token` | Session | Link an external identity to an org user |

The Teams endpoint must verify the Bot Framework JWT (issuer, audience, signing
keys) and the tenant/installation mapping. WhatsApp must verify
`X-Hub-Signature-256` HMAC-SHA256 with the Meta app secret over the raw body;
GET verification is separate. Meta retries webhook deliveries, so acknowledge
quickly and dedupe before processing. Both need idempotency:

- Teams: activity ID + installation.
- WhatsApp: `messages[0].id` / status ID + phone number ID.
- Slack: existing event ID path.

### 5.4 App and connector parity

The same MCP catalog is used everywhere. The adapter only affects presentation:

| Connector UX | Slack | Teams | WhatsApp |
|---|---|---|---|
| Discover connector | Block Kit catalog/connect card | Adaptive Card | Link to console |
| OAuth connect | In-surface button | Link/SSO + per-app OAuth | Link to console; in-chat OAuth not possible |
| Invoke tool | Natural language + cards | Natural language + cards | Natural language |
| Review result | Rich cards | Adaptive Cards | Text + link |
| Consequential action | Approval card | Approval card | 1:1 approval card or console |

Preserve `personalConnectionsOnly: true` for member turns on Teams and WhatsApp
unless the org-shared connection policy is deliberately changed. A Teams SSO
login proves who the user is; it does not grant Gmail/GitHub/Notion access.

### 5.5 Identity linking

**Teams**

1. Exchange the Teams SSO token for an Entra ID token where supported.
2. Resolve `tid` + `oid` (or `aadObjectId`) to a Company Brain user and org
   membership.
3. In channels, where SSO is unavailable, use `aadObjectId` + tenant +
   Graph/RSC membership, or issue a link code that opens the console.
4. Store the Teams MRI, `aadObjectId`, tenant ID, and conversation references.
5. Do not auto-provision guests or external tenants; require an explicit policy.

**WhatsApp**

1. User messages the business number; webhook returns `wa_id` and phone number.
2. If unlinked, send a single-use link to the console. The link requires an
   authenticated Company Brain session and org membership, plus an email/domain
   or SSO check.
3. Optionally verify the phone with an OTP, but do not treat phone possession as
   enterprise identity by itself.
4. Store `wa_id`, normalized E.164 phone, org/user, verification method,
   opt-in timestamp, and consent evidence.
5. Support unlink, phone change, lost-device revocation, and opt-out.
6. For high-risk approvals, require a step-up to the console/SSO rather than
   accepting a WhatsApp tap alone.

`wa_id` and the phone number may not match. Normalize both and key the identity
on the verified link, not on the profile name.

## 6. Enterprise assessment

### 6.1 Teams gates

| Gate | Status | Action |
|---|---|---|
| Entra tenant and app registration | Required | Register the bot/app; support multi-tenant or per-tenant installs |
| Teams app package and catalog | Required | Manifest, icons, `webApplicationInfo`, RSC declarations, `supportsChannelFeatures: tier1` (manifest v1.25+) for shared/private channels |
| Admin consent | Required for Graph/RSC scopes | Plan a tenant-admin onboarding flow |
| SSO | Personal/group only | Channel identity needs `aadObjectId` + Graph/RSC or link code |
| Ambient ingestion | RSC owner consent | Request only if the product promise includes channel observation |
| Private/shared channels | Validation gate | Test card delivery per tenant/client; fall back to DM/group |
| Graph protected APIs | Admin consent + Microsoft review for broad scopes | Avoid tenant-wide message reads unless required |
| Files | Graph/SharePoint/OneDrive; not supported in GCC High/DoD | Scope file features by cloud |
| Rate/size limits | Hard | Queue and coalesce; target <80 KB messages |
| Data residency | Tenant/cloud dependent | Confirm GCC/region support before launch |

Teams is a strong enterprise fit because identity, tenant isolation, DLP, and
eDiscovery already exist in Microsoft 365. The cost is onboarding complexity and
the channel-specific identity gap.

### 6.2 WhatsApp gates

| Gate | Status | Action |
|---|---|---|
| Meta app and business verification | Required | Decide Tech Provider vs Solution Partner; plan App Review |
| WABA/Messaging account and phone | Required per customer | Embedded Signup v4 (v2/v3 deprecated 2026-10-15); map `phone_number_id` and `messaging_account_id` now, and `waac_id` when it is exposed; existing WABA ID becomes the Messaging account ID during migration |
| Identity | No native SSO | Link phone/`wa_id` to an org user through console SSO/OTP |
| Opt-in | Required before messaging | Capture consent; support opt-out |
| 24-hour window | Hard | Track per user; use approved templates outside it |
| Templates | Review up to 24h; quality/pacing can pause | Pre-approve utility/URL approval templates; monitor status webhooks |
| Message editing | Not available | Resolve with follow-up, not in-place |
| Groups | OBA only; max 8; no interactive messages | Keep approvals 1:1 |
| Data processing | Meta decrypts Cloud API messages; retention up to 30 days; not end-to-end encrypted from the business | Redact sensitive data; use console link for high-risk approvals |
| Pricing | Per delivered message; 1,000 free service messages/phone/month | Model cost by market and category; templates may be recategorized |
| Throughput | 80 mps default; 20 mps for coexistence numbers; auto-upgrade to 1,000 mps; pair rate limits | Queue per phone; back off |
| Account model | WABA splits into WAAC (phone number) + Messaging account (templates/billing); rollout in progress | Existing phone-number IDs and tokens work through the rollout; store the Messaging account ID now and the WAAC ID when exposed; plan for Phase 3, when Messages API calls target the WAAC ID |

WhatsApp is a strong *reach* channel and a weak *enterprise system of record*.
That is the core reason to limit its scope.

### 6.3 Cross-surface risks

- **Double decision.** The same approval could be posted to Slack and Teams.
  Store one approval and multiple presentations; first valid decision wins and
  all presentations resolve.
- **Stale cards.** Slack/Teams cards can outlive the turn; WhatsApp buttons
  definitely do. Always revalidate pending/expiry/turn currency on click.
- **Identity collision.** Two org users could link the same phone; one phone
  could move between users. Enforce unique active links and revocation.
- **Data leakage.** Approval summaries can contain email bodies, ticket text, or
  customer data. Redact before WhatsApp, and put sensitive detail behind the
  console link.
- **Connector consent confusion.** Teams SSO is not connector OAuth. WhatsApp
  cannot open an OAuth window. Always show “Connect in console” when needed.
- **Audit fragmentation.** Log the surface, installation, message ID, actor,
  decision, and resume result for every approval.

### 6.4 Cost model

- **Teams:** Microsoft 365 licensing plus Azure Bot/Agents infrastructure and
  Graph calls. No per-message platform fee.
- **WhatsApp:** Per delivered message by category and market. Service messages
  are free for the first 1,000 per business phone per month as of the October 1,
  2026 pricing update; after that they are billable. Utility/authentication
  volume tiers exist. Template recategorization can change the rate. Without a
  payment method on the Messaging account, Meta delivers only the free-tier
  service messages.
- **Operational cost:** Meta business verification, Embedded Signup support,
  template review/appeals, quality monitoring, number management, and opt-in
  support are real costs even before message fees.

## 7. Delivery plan

### Phase 0 — Surface foundation

- Introduce `SurfaceAdapter`, normalized actor/conversation/message references,
  and capability flags.
- Generalize `PendingApproval` and add multi-presentation support without
  changing Slack's behavior.
- Add contract tests for asker-only, expiry, idempotency, supersession, and
  redaction.
- Keep Slack behind the existing path; use a feature flag for new surfaces.

### Phase 1 — Teams foundation

- Bot registration, app manifest, icons, tenant install, SSO.
- Personal and group chat turns; channel @mentions; progress cards.
- Identity mapping and org membership checks.
- Memory scope and connector policy; verify `personalConnectionsOnly`.
- 1:1 streaming only; channel progress via message edits.

### Phase 2 — Teams parity

- Adaptive Card approvals with `refresh.userIds` and `Action.Execute`.
- Asker-only decision validation, edit-based resolution, expiry alarms.
- Channel/group approvals; private/shared-channel validation and fallback.
- RSC ambient ingestion (explicit consent), proactive notifications, files,
  reactions/feedback, connector connect cards.
- Load tests against 7/sec/conversation, 50 RPS/tenant, ~100 KB message cap.

### Phase 3 — WhatsApp foundation

- Meta app, Embedded Signup v4, WABA/Messaging account and phone mapping.
- Webhook verification, signature validation, dedupe, status handling; size for
  3x outbound plus inbound, with median latency under 250 ms.
- Identity link/OTP/SSO, opt-in, opt-out, phone change, revocation.
- 1:1 text Q&A, typing/read receipts, media, simple notifications.
- Per-phone send queue and 24-hour window tracking.

### Phase 4 — WhatsApp approvals

- In-window interactive reply buttons for asker-only approvals.
- Out-of-window approved utility template with URL-to-console fallback.
- Optional Flow for structured decisions/comments; `flow_token` carries the ID.
- Follow-up resolution messages; late-click handling.
- Never group approvals; no ambient channel behavior.
- Cost, quality, template, and delivery monitoring.

### Phase 5 — Enterprise hardening

- Multi-tenant admin, surface status/disconnect, audit export.
- Data retention/redaction policy per surface.
- Rate-limit, retry, and failover runbooks.
- Security review of identity linking and decision proofs.
- Pricing/usage reporting for WhatsApp; Teams app catalog rollout.

### Acceptance criteria

- Teams ask in DM, group, and channel; answer is correct and scoped.
- Only the asker sees approval buttons; only the asker can decide.
- A second click/decision cannot run the tool twice.
- Expiry and supersession update every surface and do not resume stale work.
- The same connector catalog works from Teams and WhatsApp after identity link.
- WhatsApp approval works in-window; outside the window it falls back to an
  approved template + console link.
- WhatsApp group/channel approvals are explicitly unsupported, not silently
  broken.
- Sensitive approval detail is not sent over WhatsApp by default.

## 8. Open decisions

1. **Audience.** Is WhatsApp for internal employees, field/ops staff, or external
   customers? The product shape and compliance bar differ substantially.
2. **WhatsApp scope.** Is the goal notifications + approvals, or full Q&A? If
   full Q&A, who owns identity and opt-in support?
3. **Approval policy.** Keep asker-only for all surfaces, or add named approvers?
   Multi-approver changes the Teams card and WhatsApp state model.
4. **Expiry.** Is 15 minutes right for WhatsApp, or should template approvals get
   30–60 minutes?
5. **High-risk actions.** Are any tools prohibited on WhatsApp, or allowed only
   through the SSO console?
6. **Teams channels.** Do we need ambient channel ingestion, or only @mentions?
   RSC requires owner consent and changes the privacy story.
7. **Private/shared channels.** Which Teams clients/tenants must support card
   delivery? Test before committing to parity.
8. **Meta model.** Are we a Tech Provider or Solution Partner? Who owns business
   verification, billing, and phone numbers?
9. **Connector OAuth.** Is a console link acceptable for WhatsApp, or must we
   build an in-WhatsApp Flow for app connection? OAuth still needs a browser.
10. **Data residency.** Are there tenants that cannot use Meta Cloud API or
    Microsoft multi-tenant infrastructure?

## 9. Sources

Official documentation reviewed on 2026-10-27. Product docs change; re-check
before implementation.

**Microsoft Teams**

- Up-to-date Adaptive Card views and approval base cards:
  https://learn.microsoft.com/en-us/microsoftteams/platform/task-modules-and-cards/cards/universal-actions-for-adaptive-cards/up-to-date-views
- Universal Actions, refresh model, `userIds`, 60-MRI limit:
  https://learn.microsoft.com/en-us/microsoftteams/platform/task-modules-and-cards/cards/universal-actions-for-adaptive-cards/work-with-universal-actions-for-adaptive-cards
- All-message RSC for group chats/channels:
  https://learn.microsoft.com/en-us/microsoftteams/platform/agents-in-teams/enable-receive-all-chat-messages
- SSO scope limitation (personal/group, not channel):
  https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/authentication/bot-sso-overview
- Channel/group conversations and default @mention behavior:
  https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/channel-and-group-conversations
- Shared/private channel app support:
  https://learn.microsoft.com/en-us/microsoftteams/platform/build-apps-for-shared-private-channels
- Rate limits:
  https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/rate-limit
- Streaming UX:
  https://learn.microsoft.com/en-us/microsoftteams/platform/bots/streaming-ux
- Files in Teams:
  https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/bots-filesv4
- Proactive messages:
  https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/conversations/send-proactive-messages
- Message size limit:
  https://learn.microsoft.com/en-us/microsoftteams/platform/bots/how-to/format-your-bot-messages
- App package and publishing:
  https://learn.microsoft.com/en-us/microsoftteams/platform/concepts/build-and-test/apps-package
  https://learn.microsoft.com/en-us/microsoftteams/platform/concepts/deploy-and-publish/apps-publish-overview

**WhatsApp Cloud API**

- Webhooks overview and endpoint verification:
  https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/overview
  https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/create-webhook-endpoint
- Quick-reply button webhook (template payload = label):
  https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/button
- Reaction webhook:
  https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/reaction
- User-side edit/revoke webhooks (WhatsApp Business app coexistence only; not
  business message updates):
  https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/edit
  https://developers.facebook.com/documentation/business-messaging/whatsapp/webhooks/reference/messages/revoke
- Interactive reply buttons (3 buttons, 20-char labels, 256-char IDs):
  https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/interactive-reply-buttons-messages
- Utility templates (10 buttons, 25-char labels):
  https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/utility-templates/utility-templates
- Template review (up to 24 hours):
  https://developers.facebook.com/documentation/business-messaging/whatsapp/templates/template-review
- Send a Flow and Flow templates:
  https://developers.facebook.com/documentation/business-messaging/whatsapp/flows/guides/sendingaflow
- Flow response webhooks (`nfm_reply`, `flow_token`):
  https://developers.facebook.com/documentation/business-messaging/whatsapp/flows/guides/flowswebhooks
- Groups API (OBA, max 8, no interactive messages):
  https://developers.facebook.com/documentation/business-messaging/whatsapp/groups
- Service messages and 24-hour customer-service window:
  https://developers.facebook.com/documentation/business-messaging/whatsapp/messages/send-messages
- Opt-in:
  https://developers.facebook.com/documentation/business-messaging/whatsapp/getting-opt-in
- Pricing (per delivered message, 1,000 free service messages/phone/month):
  https://developers.facebook.com/documentation/business-messaging/whatsapp/pricing
- Throughput (80 mps default, auto-upgrade):
  https://developers.facebook.com/documentation/business-messaging/whatsapp/throughput
- Account model evolution (WAAC + Messaging account):
  https://developers.facebook.com/documentation/business-messaging/whatsapp/account-model-evolution
- Embedded Signup v4 (v2/v3 deprecation):
  https://developers.facebook.com/documentation/business-messaging/whatsapp/embedded-signup/overview
- Data privacy and security (Meta decryption, 30-day retention):
  https://developers.facebook.com/documentation/business-messaging/whatsapp/data-privacy-and-security
- Media types and size limits:
  https://developers.facebook.com/documentation/business-messaging/whatsapp/business-phone-numbers/media
