import type { ReactNode } from "react";
import { Badge, Badges, InvalidArg, Output, ResultText } from "../parts";
import type { ToolRenderer, ToolRenderProps } from "../types";
import { detailsRecord, normalizeWs, str, truncate } from "../util";

function Summary({ args, result }: ToolRenderProps): ReactNode {
	const statement = str(args.statement);
	const status = str(detailsRecord(result)?.status);
	return (
		<>
			{statement ? <span>{truncate(normalizeWs(statement), 96)}</span> : <InvalidArg what="statement" />}
			{status && (
				<>
					{" "}
					<Badge tone={status === "queued" ? "ok" : "warn"}>{status}</Badge>
				</>
			)}
		</>
	);
}

function Body({ args, result }: ToolRenderProps): ReactNode {
	return (
		<>
			<Badges
				items={[
					str(args.scope),
					str(args.form),
					str(args.domain),
					str(args.source),
					str(args.confidence),
					str(args.request_origin),
				]}
			/>
			{str(args.knowledge_key) && <Output text={str(args.knowledge_key) ?? ""} title="knowledge key" maxLines={2} />}
			{str(args.future_use) && <Output text={str(args.future_use) ?? ""} title="future use" maxLines={4} />}
			<ResultText result={result} maxLines={10} />
		</>
	);
}

export const knowledgeRetainRenderer: ToolRenderer = { Summary, Body };
