import { test } from "node:test";
import assert from "node:assert/strict";
import { setLang } from "../src/i18n/index.ts";
import {
	initLangPrompt,
	langPromptInput,
	renderLangPrompt,
	type LangPromptState,
} from "../src/setup-lang-prompt.ts";

setLang("es");

test("initLangPrompt defaults to selected language and not done", () => {
	const s = initLangPrompt("es");
	assert.equal(s.selected, "es");
	assert.equal(s.persist, false);
	assert.equal(s.done, false);
	assert.equal(s.cancelled, false);

	const en = initLangPrompt("en");
	assert.equal(en.selected, "en");
});

test("langPromptInput toggles selection with arrow keys, numbers and letters", () => {
	let s = initLangPrompt("es");

	// Key 2 selects en
	s = langPromptInput(s, { type: "key", data: "2" });
	assert.equal(s.selected, "en");

	// Key 1 selects es
	s = langPromptInput(s, { type: "key", data: "1" });
	assert.equal(s.selected, "es");

	// Down arrow toggles
	s = langPromptInput(s, { type: "key", data: "\x1b[B" });
	assert.equal(s.selected, "en");

	// Up arrow toggles back
	s = langPromptInput(s, { type: "key", data: "\x1b[A" });
	assert.equal(s.selected, "es");

	// j / k toggles
	s = langPromptInput(s, { type: "key", data: "j" });
	assert.equal(s.selected, "en");
	s = langPromptInput(s, { type: "key", data: "k" });
	assert.equal(s.selected, "es");
});

test("Enter or Space completes for current session without persistence", () => {
	let s = initLangPrompt("es");
	s = langPromptInput(s, { type: "key", data: "\r" });
	assert.equal(s.done, true);
	assert.equal(s.persist, false);
	assert.equal(s.cancelled, false);
	assert.equal(s.selected, "es");

	let s2 = initLangPrompt("en");
	s2 = langPromptInput(s2, { type: "key", data: " " });
	assert.equal(s2.done, true);
	assert.equal(s2.persist, false);
	assert.equal(s2.selected, "en");
});

test("P or p completes and requests persistence", () => {
	let s = initLangPrompt("es");
	s = langPromptInput(s, { type: "key", data: "p" });
	assert.equal(s.done, true);
	assert.equal(s.persist, true);
	assert.equal(s.cancelled, false);
	assert.equal(s.selected, "es");

	let s2 = initLangPrompt("en");
	s2 = langPromptInput(s2, { type: "key", data: "P" });
	assert.equal(s2.done, true);
	assert.equal(s2.persist, true);
	assert.equal(s2.selected, "en");
});

test("Escape cancels the prompt", () => {
	let s = initLangPrompt("es");
	s = langPromptInput(s, { type: "key", data: "\x1b" });
	assert.equal(s.cancelled, true);
});

test("renderLangPrompt renders box with options and key hints", () => {
	const s = initLangPrompt("es");
	const lines = renderLangPrompt(s, 60, "none");
	assert.ok(lines.length > 5);
	const text = lines.join("\n");
	assert.match(text, /Español/);
	assert.match(text, /English/);
	assert.match(text, /\[ 1 \]/);
	assert.match(text, /\[ 2 \]/);
});
