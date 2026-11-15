import type { ScopedThreadRef, ThreadMoveState } from "@t3tools/contracts";
import { Pressable, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { appAtomRegistry } from "../../state/atom-registry";
import { threadMoveSheetAtom } from "../../state/threadMove";

export function ThreadMoveCard(props: {
  readonly threadRef: ScopedThreadRef;
  readonly move: ThreadMoveState | null | undefined;
}) {
  const { move } = props;
  if (move == null || move.direction !== "outgoing") return null;
  const complete = move.phase === "complete";
  return (
    <View className="mx-3 mb-2 gap-1 rounded-xl border border-warning-foreground/25 bg-screen p-3">
      <Text className="text-sm font-t3-medium text-foreground">
        {complete ? `Moved to ${move.label}` : `Moving to ${move.label}`}
      </Text>
      <Text className="text-sm text-foreground-muted">
        {complete
          ? "This thread continues on the other machine. This copy is read-only."
          : "The move has not finished. Retry it, or cancel to keep working here."}
      </Text>
      <Pressable
        accessibilityRole="button"
        hitSlop={{ left: 8, right: 8 }}
        onPress={() => appAtomRegistry.set(threadMoveSheetAtom, props.threadRef)}
        className="-mb-3 -mt-2 min-h-11 justify-center self-start active:opacity-70"
      >
        <Text className="text-sm font-t3-medium text-primary">
          {complete ? "Open" : "Retry or cancel"}
        </Text>
      </Pressable>
    </View>
  );
}
