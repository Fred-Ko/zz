import { describe, expect, it } from "bun:test";
import {
	detectExplicitKnowledgeIntent,
	renderExplicitKnowledgeNotice,
} from "@oh-my-pi/pi-coding-agent/knowledge/conversation-intent";

describe("explicit ZZ Knowledge requests", () => {
	it("distinguishes retain, recall, correction, and deletion requests", () => {
		expect(detectExplicitKnowledgeIntent("앞으로 특별한 요청이 없으면 한글로 대화해. 기억해 둬.")).toBe("retain");
		expect(detectExplicitKnowledgeIntent("내가 전에 선호한다고 했던 방식 기억나?")).toBe("recall");
		expect(detectExplicitKnowledgeIntent("그 기억은 잘못됐어. 올바른 내용으로 정정해.")).toBe("correct");
		expect(detectExplicitKnowledgeIntent("방금 저장한 장기 지식 전부 삭제해.")).toBe("forget");
	});

	it("injects an operational instruction only for explicit requests", () => {
		const notice = renderExplicitKnowledgeNotice("이 규칙을 장기 기억에 저장해 둬.");
		expect(notice).toContain('intent="retain"');
		expect(notice).toContain("request_origin=user-explicit");
		expect(renderExplicitKnowledgeNotice("Knowledge 시스템의 구조를 설명해줘.")).toBeUndefined();
	});
});
