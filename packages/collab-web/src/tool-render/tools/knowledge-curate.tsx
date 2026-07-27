import type { ReactNode } from "react";
import { Badge, InvalidArg, Output, ResultText } from "../parts";
import type { ToolRenderer, ToolRenderProps } from "../types";
import { normalizeWs, str, truncate } from "../util";

function Summary({ args }: ToolRenderProps): ReactNode {
	const documentId = str(args.document_id);
	const action = str(args.action);
	return (
		<>
			{documentId ? <span>{truncate(normalizeWs(documentId), 96)}</span> : <InvalidArg what="document_id" />}
			{action && (
				<>
					{" "}
					<Badge tone="accent">{action}</Badge>
				</>
			)}
		</>
	);
}

function Body({ args, result }: ToolRenderProps): ReactNode {
	return (
		<>
			{str(args.reason) && <Output text={str(args.reason) ?? ""} title="reason" maxLines={6} />}
			<ResultText result={result} maxLines={10} />
		</>
	);
}

export const knowledgeCurateRenderer: ToolRenderer = { Summary, Body };
