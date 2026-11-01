// Form cards (M9, ask_form): checking a submission against the card's fields (contract §2), the
// readable summary of the answers, and the line the model reads for an answered form. Pure
// functions; the run host stores the submission, CardActions handles Skip ("dismiss").
import type { z } from "zod";
import { FormMessage, type FormAnswer } from "../contract/messages.ts";

export type FormPayload = z.output<typeof FormMessage.shape.payload>;
export type Answer = z.output<typeof FormAnswer>;
export type FormCheck = { ok: true; answers: Answer[]; summary: string } | { ok: false; message: string };

/** What a submitted form's user message keeps in its payload (never sent to the app). */
export interface FormNote { messageId: string; title: string; summary: string }

/** A stored form card's payload, or null when the row isn't a readable form. */
export function parseForm(raw: string): FormPayload | null {
  try {
    const parsed = FormMessage.shape.payload.safeParse(JSON.parse(raw));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

/**
 * Every answer's field exists; option ids belong to their field; a single field takes exactly
 * one option, or only typed text when it allows "Other"; a multi field any of its options plus
 * "Other" text when allowed; a text field only text; every required field is answered. Answers
 * come back in the card's field order, empty ones dropped.
 */
export function checkAnswers(form: FormPayload, answers: readonly Answer[]): FormCheck {
  const fields = new Map(form.fields.map((f) => [f.id, f]));
  const given = new Map<string, Answer>();
  for (const answer of answers) {
    const field = fields.get(answer.fieldId);
    if (!field) return fail(`unknown field ${answer.fieldId}`);
    if (given.has(field.id)) return fail(`field ${field.id} is answered twice`);
    const ids = answer.optionIds;
    const text = answer.text?.trim() ? answer.text.trim() : null;
    if (new Set(ids).size !== ids.length) return fail(`field ${field.id} has an option twice`);
    if (field.type === "text") {
      if (ids.length) return fail(`field ${field.id} takes text, not options`);
      given.set(field.id, { fieldId: field.id, optionIds: [], text });
      continue;
    }
    const unknown = ids.find((id) => !field.options.some((o) => o.id === id));
    if (unknown !== undefined) return fail(`field ${field.id} has no option ${unknown}`);
    if (text && !field.allowOther) return fail(`field ${field.id} takes no typed answer`);
    if (field.type === "single" && ids.length + (text ? 1 : 0) > 1) return fail(`field ${field.id} takes one answer`);
    given.set(field.id, { fieldId: field.id, optionIds: [...ids], text });
  }
  const ordered: Answer[] = [];
  for (const field of form.fields) {
    const answer = given.get(field.id);
    const empty = !answer || (answer.optionIds.length === 0 && !answer.text);
    if (empty && field.required) return fail(`field ${field.id} is required`);
    if (!empty) ordered.push(answer);
  }
  return { ok: true, answers: ordered, summary: summarize(form, ordered) };
}

/** One "<label>: <answer>" line per answered question; options joined with ", ", typed text as written. */
export function summarize(form: FormPayload, answers: readonly Answer[]): string {
  return answers.flatMap((answer) => {
    const field = form.fields.find((f) => f.id === answer.fieldId);
    if (!field) return [];
    const labels = field.type === "text" ? [] : answer.optionIds.flatMap((id) => field.options.find((o) => o.id === id)?.label ?? []);
    return [`${field.label}: ${[...labels, ...(answer.text ? [answer.text] : [])].join(", ")}`];
  }).join("\n");
}

/** What the model reads for the user's form submission (contract §2). */
export const answeredLine = (note: Pick<FormNote, "title" | "summary">): string => `Form ${JSON.stringify(note.title)} answered: ${note.summary}`;

/** The form note a submitted user message keeps in its stored payload, or null. */
export function formNoteOf(payload: Record<string, unknown>): FormNote | null {
  const note = payload.form;
  if (!note || typeof note !== "object" || Array.isArray(note)) return null;
  const { messageId, title, summary } = note as Record<string, unknown>;
  return typeof messageId === "string" && typeof title === "string" && typeof summary === "string" ? { messageId, title, summary } : null;
}

function fail(message: string): FormCheck {
  return { ok: false, message };
}
