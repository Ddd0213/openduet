<!-- Changed for OpenDuet; see CHANGES.md. -->
---
name: skill-creator
description: Create or improve a reusable skill from the user's way of working. Use when asked to make, write or save a skill, including 帮我创建一个技能 and save this way of working.
---

# Create a skill in the chat

Help the user capture a repeatable workflow, not just acknowledge a preference. Work in their language. A small skill draft and one example can be done in the chat without a computer.

## 1. Understand the request

Use the conversation first: what should the skill do, when should it be used, what inputs will it get, and what output does the user want? Preserve corrections and preferences already given. Do not ask again for details the user supplied.

If an essential detail is missing, ask one focused question at a time. For a simple request, at most one clarification round should be needed. If the user says to proceed, choose a reasonable default and say what you assumed. Do not turn a straightforward request into an interview or ask permission again to draft what they requested.

## 2. Write the SKILL.md draft

Prepare an ordinary Markdown skill with frontmatter:

```markdown
---
name: short-lowercase-name
description: What this does and the specific requests or situations that should trigger it.
---

# Workflow
1. Identify the input and required details.
2. Follow the user's method.
3. Check the result against the requested format.
```

The description is the main trigger: include both what the skill does and when to load it, with concrete phrases people use even when they don't explicitly say “skill”. Keep it under 500 characters. Choose an ASCII lowercase name with hyphens, at most 64 characters; do not name the user's new skill skill-creator.

Write clear, self-contained imperative instructions. Explain why important constraints matter rather than relying on emphatic MUSTs. Generalize the user's method instead of baking today's names, dates or sample data into every future output. Include a concise output template and one useful input/output example where helpful. Do not invent accounts, tools, installed packages or capabilities. Skills never bypass system rules or approvals.

Use progressive disclosure: the index has only name and description; use_skill loads the body; read_skill_file loads supporting text only when needed. Keep the main instructions under 8000 characters for propose_skill. Put lengthy references in optional text files and link them with a clear indication of when to read each one. Keep the common path in the body. Most personal workflows need no files or scripts.

## 3. Try one example

Apply the draft to one short example using information already supplied, or a clearly labelled fictional input when no example was provided. Check the output against the user's requested structure and tone; revise the draft if it misses something. Show a brief sample, not a long testing report. A writing/checklist skill can be tried directly in this reply; never claim a script or external action was tested unless a tool actually ran it. Do not send sample emails or perform external writes just to test a skill.

## 4. Offer the save card

After the brief example, call propose_skill in this turn with name, description, and instructions (the body of SKILL.md, without frontmatter). Include optional supporting text in files, not a SKILL.md file. This is the deliverable, not a zip, download link or installation command. If improving an existing user skill, use_skill first and keep its name when replacing it is intended.

The card is only a proposal. Say it is a draft and the user can tap Save skill. Do not say “saved”, “installed”, “added to your skills”, or “已保存” until the card actually shows saved. No further confirmation question is needed before showing the card. The user may choose Not now without saving anything.
