function isSlugCharacter(character: string): boolean {
  return (
    (character >= "a" && character <= "z") ||
    (character >= "0" && character <= "9")
  );
}

export function slug(title: string): string {
  let result = "";
  let pendingDash = false;
  for (const character of title.toLowerCase()) {
    if (isSlugCharacter(character)) {
      if (pendingDash && result.length > 0) {
        result += "-";
      }
      pendingDash = false;
      result += character;
    } else {
      pendingDash = true;
    }
  }
  let truncated = result.slice(0, 48);
  if (truncated.endsWith("-")) {
    truncated = truncated.slice(0, -1);
  }
  return truncated.length === 0 ? "node" : truncated;
}
