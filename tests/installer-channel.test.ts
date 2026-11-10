import { test } from "node:test";
import assert from "node:assert/strict";
import { setLang } from "../src/i18n/index.ts";
import { cellWidth } from "../src/tui-box.ts";
import { CHANNEL_ROW_Y, channelPromptInput, initChannelPrompt, renderChannelPrompt } from "../src/installer-channel.ts";

const key = (data: string) => ({ type: "key" as const, data });
const strip = (s: string) => s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\uE000[\uE010-\uE01F]|\uE001/g, "");

test("starts on terminal, not done", () => {
	const s = initChannelPrompt();
	assert.deepEqual(s, { selected: "terminal", done: false, cancelled: false });
});

test("1/2, arrows, j/k and Tab choose the channel", () => {
	let s = initChannelPrompt();
	s = channelPromptInput(s, key("2"));
	assert.equal(s.selected, "web");
	s = channelPromptInput(s, key("1"));
	assert.equal(s.selected, "terminal");
	for (const k of ["\x1b[B", "j", "\t"]) {
		assert.equal(channelPromptInput(initChannelPrompt(), key(k)).selected, "web");
		assert.equal(channelPromptInput({ ...initChannelPrompt(), selected: "web" }, key(k.replace("\x1b[B", "\x1b[A"))).selected, "terminal");
	}
	assert.equal(channelPromptInput({ ...initChannelPrompt(), selected: "web" }, key("k")).selected, "terminal");
});

test("Enter and Space confirm, Esc and q cancel, other keys do nothing, finished state is frozen", () => {
	assert.equal(channelPromptInput(initChannelPrompt(), key("\r")).done, true);
	assert.equal(channelPromptInput(initChannelPrompt(), key(" ")).done, true);
	assert.equal(channelPromptInput(initChannelPrompt(), key("\x1b")).cancelled, true);
	assert.equal(channelPromptInput(initChannelPrompt(), key("q")).cancelled, true);
	assert.deepEqual(channelPromptInput(initChannelPrompt(), key("z")), initChannelPrompt());
	const done = channelPromptInput(initChannelPrompt(), key("\r"));
	assert.equal(channelPromptInput(done, key("2")), done);
});

test("a click on an option row chooses and confirms it", () => {
	const web = channelPromptInput(initChannelPrompt(), { type: "mouse", kind: "click", x: 5, y: CHANNEL_ROW_Y.web });
	assert.deepEqual(web, { selected: "web", done: true, cancelled: false });
	const term = channelPromptInput({ ...initChannelPrompt(), selected: "web" }, { type: "mouse", kind: "click", x: 5, y: CHANNEL_ROW_Y.terminal });
	assert.deepEqual(term, { selected: "terminal", done: true, cancelled: false });
	assert.deepEqual(channelPromptInput(initChannelPrompt(), { type: "mouse", kind: "click", x: 5, y: 0 }), initChannelPrompt());
});

test("renders the question and both options in English and Spanish at exact widths", () => {
	for (const [lang, question, terminal, web] of [
		["en", "Where do you want to install?", "Install via terminal", "Install via web"],
		["es", "¿Dónde querés hacer la instalación?", "Instalación vía terminal", "Instalación vía web"],
	] as const) {
		setLang(lang);
		for (const mode of ["truecolor", "ansi", "none"] as const) {
			const lines = renderChannelPrompt(initChannelPrompt(), 60, mode);
			const out = lines.map(strip).join("\n");
			assert.ok(out.includes(question));
			assert.ok(out.includes(terminal));
			assert.ok(out.includes(web));
			for (const l of lines) assert.equal(cellWidth(l), 60);
			assert.ok(strip(lines[CHANNEL_ROW_Y.terminal]!).includes(terminal));
			assert.ok(strip(lines[CHANNEL_ROW_Y.web]!).includes(web));
		}
		assert.match(renderChannelPrompt(initChannelPrompt(), 60, "none").map(strip).join("\n"), /▸ .*\[ 1 \]/);
	}
	setLang("en");
});
