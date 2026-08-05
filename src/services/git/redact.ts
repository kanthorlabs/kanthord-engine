const userinfoPattern = /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)[^\s/@]+@/g;

export function stripUserinfo(text: string): string {
  return text.replace(userinfoPattern, "$1");
}
