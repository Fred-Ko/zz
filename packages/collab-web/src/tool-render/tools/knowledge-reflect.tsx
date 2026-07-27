import type { ReactNode } from "react";
import { Badges, InvalidArg, Output, ResultText } from "../parts";
import type { ToolRenderer, ToolRenderProps } from "../types";
import { normalizeWs, str, truncate } from "../util";

function Summary({ args }: ToolRenderProps): ReactNode {
	const question = str(args.question);
	return question ? <span>{truncate(normalizeWs(question), 96)}</span> : <InvalidArg what="question" />;
}

function Body({ args, result }: ToolRenderProps): ReactNode {
	return (
		<>
			<Badges items={[str(args.purpose)]} />
			{str(args.question) && <Output text={str(args.question) ?? ""} title="question" maxLines={4} />}
			<ResultText result={result} maxLines={16} />
		</>
	);
}

export const knowledgeReflectRenderer: ToolRenderer = { Summary, Body };
