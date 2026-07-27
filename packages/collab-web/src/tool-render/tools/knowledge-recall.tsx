import type { ReactNode } from "react";
import { Badge, Badges, InvalidArg, Output, ResultText } from "../parts";
import type { ToolRenderer, ToolRenderProps } from "../types";
import { detailsRecord, normalizeWs, num, str, truncate } from "../util";

function Summary({ args, result }: ToolRenderProps): ReactNode {
	const query = str(args.query);
	const count = num(detailsRecord(result)?.count);
	return (
		<>
			{query ? <span>{truncate(normalizeWs(query), 96)}</span> : <InvalidArg what="query" />}
			{count !== null && (
				<>
					{" "}
					<Badge tone={count > 0 ? "accent" : "warn"}>{count} found</Badge>
				</>
			)}
		</>
	);
}

function Body({ args, result }: ToolRenderProps): ReactNode {
	const purpose = str(args.purpose);
	const depth = str(args.depth);
	const details = detailsRecord(result);
	return (
		<>
			<Badges
				items={[
					purpose,
					depth,
					details?.cached === true ? "cached" : null,
					details?.degraded === true ? "degraded" : null,
				]}
			/>
			{str(args.query) && <Output text={str(args.query) ?? ""} title="query" maxLines={4} />}
			<ResultText result={result} maxLines={16} />
		</>
	);
}

export const knowledgeRecallRenderer: ToolRenderer = { Summary, Body };
