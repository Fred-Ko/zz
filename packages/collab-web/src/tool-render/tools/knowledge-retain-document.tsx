import type { ReactNode } from "react";
import { Badge, Badges, InvalidArg, Output, ResultText } from "../parts";
import type { ToolRenderer, ToolRenderProps } from "../types";
import { detailsRecord, normalizeWs, str, truncate } from "../util";

function Summary({ args, result }: ToolRenderProps): ReactNode {
	const title = str(args.title);
	const status = str(detailsRecord(result)?.status);
	return (
		<>
			{title ? <span>{truncate(normalizeWs(title), 96)}</span> : <InvalidArg what="title" />}
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
					str(args.content_class),
					str(args.scope),
					str(args.domain),
					str(args.source),
					str(args.update_mode),
					str(args.request_origin),
				]}
			/>
			{str(args.source_id) && <Output text={str(args.source_id) ?? ""} title="source" maxLines={2} />}
			{str(args.future_use) && <Output text={str(args.future_use) ?? ""} title="future use" maxLines={4} />}
			<ResultText result={result} maxLines={10} />
		</>
	);
}

export const knowledgeRetainDocumentRenderer: ToolRenderer = { Summary, Body };
