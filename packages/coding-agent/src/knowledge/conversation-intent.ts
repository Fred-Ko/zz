import { escapeXmlText, prompt } from "@oh-my-pi/pi-utils";
import noticePrompt from "../prompts/knowledge/conversation-intent.md" with { type: "text" };

export type ExplicitKnowledgeIntent = "retain" | "recall" | "correct" | "forget";

const FORGET =
	/(?:기억|장기\s*지식|저장한\s*(?:것|내용)).{0,16}(?:삭제|지워|잊어|무효화)|(?:forget|delete|remove|invalidate).{0,16}(?:memory|knowledge)/iu;
const CORRECT =
	/(?:기억|장기\s*지식).{0,24}(?:수정|정정|고쳐)|기억(?:은|이)?\s*(?:잘못|틀)|(?:잘못|틀리게)\s*기억|(?:correct|update|fix).{0,16}(?:memory|knowledge)/iu;
const RECALL =
	/(?:기억나|기억하고\s*있|기억\s*해\s*\?|전에\s+.{0,24}(?:했|말했|정했)|내가\s+.{0,24}(?:선호|좋아|싫어).{0,8}(?:했|하지))|(?:do you remember|what do you remember|recall|remember when)/iu;
const RETAIN =
	/(?:기억해\s*(?:둬|놔|줘)?|기억해\s*$|기억\s*해\s*둬|장기\s*(?:기억|지식).{0,12}(?:저장|남겨)|앞으로는\s+.{1,80}(?:해|하지\s*마))|(?:remember this|save this (?:to|in) memory|keep this in mind)/iu;

export function detectExplicitKnowledgeIntent(text: string): ExplicitKnowledgeIntent | undefined {
	const normalized = text.trim();
	if (!normalized) return undefined;
	if (FORGET.test(normalized)) return "forget";
	if (CORRECT.test(normalized)) return "correct";
	if (RECALL.test(normalized)) return "recall";
	if (RETAIN.test(normalized)) return "retain";
	return undefined;
}

export function renderExplicitKnowledgeNotice(text: string): string | undefined {
	const intent = detectExplicitKnowledgeIntent(text);
	if (!intent) return undefined;
	return prompt.render(noticePrompt, {
		intent,
		request: escapeXmlText(text),
	});
}
