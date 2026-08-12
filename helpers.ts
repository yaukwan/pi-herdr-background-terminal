import { randomBytes } from "node:crypto";

export interface MarkerPair {
	start: string;
	done: string;
}

export interface ParsedTaskOutput {
	started: boolean;
	output: string;
	exitCode?: number;
}

export function markerToken(): string {
	return randomBytes(16).toString("hex");
}

export function markers(token: string): MarkerPair {
	if (token.startsWith("__PI_BG_DONE_")) {
		return { start: "", done: token };
	}
	return {
		start: `__PI_BG_${token}_START__`,
		done: `__PI_BG_${token}_DONE__`,
	};
}

export function wrapCommand(command: string, token: string): string {
	const marker = markers(token);
	return `(\n  trap 'rc=130; printf "\\n${marker.done}:%s\\n" "$rc"; exit "$rc"' INT\n  set +e\n  printf '\\n${marker.start}\\n'\n  (\n    ${command}\n  )\n  rc=$?\n  printf '\\n${marker.done}:%s\\n' "$rc"\n  exit "$rc"\n)`;
}

export function parseTaskOutput(raw: string, token: string): ParsedTaskOutput {
	const marker = markers(token);
	const lines = raw.split("\n");
	const startIndex = marker.start ? lines.findIndex((line) => line === marker.start) : 0;
	const donePrefix = `${marker.done}:`;
	let doneIndex = -1;
	let exitCode: number | undefined;
	for (let index = Math.max(startIndex + 1, 0); index < lines.length; index += 1) {
		const line = lines[index] ?? "";
		if (!line.startsWith(donePrefix)) continue;
		const code = line.slice(donePrefix.length);
		if (/^-?\d+$/.test(code)) {
			doneIndex = index;
			exitCode = Number.parseInt(code, 10);
		} else if (code === "") {
			// Empty code: wrapper trap fired without a usable exit code (e.g. SIGINT
			// before rc was captured). The DONE line still marks a terminal state.
			doneIndex = index;
		}
	}
	if (startIndex === -1) return { started: false, output: "", exitCode };
	const end = doneIndex === -1 ? lines.length : doneIndex;
	return { started: true, output: lines.slice(startIndex + 1, end).join("\n").replace(/^\n/, "").trimEnd(), exitCode };
}

export function completionMarker(token: string): string {
	return markers(token).done;
}
