<!-- Changed for OpenDuet; see CHANGES.md. -->
---
name: task-management
description: Track commitments and help prioritize the user's OpenDuet tasks. Use for what's on my plate, waiting items, meeting follow-ups, and requests to take on work.
---

# Task management in OpenDuet

Use OpenDuet's actual task context and the tools offered in this turn. Never create a separate Markdown task database or a task dashboard: the app already keeps task state and sessions. Do not invent a task ID or claim you saw tasks that were not supplied in context or returned by a tool.

## Review commitments

When asked “what's on my plate”, summarize active work and items waiting on someone. Highlight known deadlines and urgent blockers. Include who each commitment is for and a due date only when provided. Distinguish a stated deadline from your suggestion. Ask for missing context if the relevant task is not visible.

When asked “what am I waiting on”, identify the owner, the outstanding input, and the known waiting date. Never infer that silence means completion.

## Take on or offer work

- In a chat, use start_task(title, prompt) for a substantial request the user explicitly asked you to perform. Include their scope, output, recipient and deadline in the prompt. The task runs in its own session; the server posts its acknowledgement. Starting is not finishing.
- For possible follow-ups, use propose_tasks with a few concrete titles and prompts. A proposal does not start work; the user starts it by tapping. Extract commitments from meeting notes, assigned action items and promised follow-ups, but offer them rather than silently starting all of them.
- A reminder is not a background task: use the offered reminder tools for a request to remind the user at a time, with the necessary timing details.
- In a task session, follow that session's available task tools to plan, record progress, or ask for missing input. Do not start nested tasks through tools that are not offered.

## Update honestly

When the user says an existing task is done or asks to cancel it, use the offered task tools and their declared semantics (for example resolve_task or delete_task) with a real task ID. Do not claim to have changed its state without a successful result. Do not erase task history on a schedule. Keep proposals, queued work, progress, waiting, and completed results distinct in the reply.
