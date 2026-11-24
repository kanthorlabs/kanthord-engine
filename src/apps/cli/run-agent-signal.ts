const SIGINT = "SIGINT";

export function stopOnSignal(controller: AbortController): () => void {
  const onSignal = () => controller.abort();
  process.once(SIGINT, onSignal);
  return () => void process.off(SIGINT, onSignal);
}
