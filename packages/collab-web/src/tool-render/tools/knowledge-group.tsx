import type { ReactNode } from "react";
import { Badge, Output, ResultText } from "../parts";
import type { ToolRenderer, ToolRenderProps } from "../types";
import { normalizeWs, str, truncate } from "../util";

function Summary({ args }: ToolRenderProps): ReactNode {
	const action = str(args.action) ?? "list";
	const groupId = str(args.group_id);
	return (
		<>
			<Badge tone="accent">{action}</Badge>
			{groupId && <> {truncate(normalizeWs(groupId), 96)}</>}
		</>
	);
}

function Body({ args, result }: ToolRenderProps): ReactNode {
	return (
		<>
			{str(args.reason) && <Output text={str(args.reason) ?? ""} title="reason" maxLines={4} />}
			<ResultText result={result} maxLines={16} />
		</>
	);
}

export const knowledgeGroupRenderer: ToolRenderer = { Summary, Body };
