import { fieldsOf, isOpen } from "./metadata.js";
import type { DtoClass } from "./types.js";

/**
 * The first reference cycle in a DTO's graph (a DTO that holds itself through `@Nested` or `@List`,
 * directly or via other DTOs), as the classes along it with the first repeated at the end
 * (`[A, B, A]`); `undefined` for a graph without one. A DTO used twice (a diamond) is not a cycle.
 * Iterative, so a very deep (finite) graph cannot overflow the stack either.
 */
export function dtoCycleOf(root: DtoClass): readonly DtoClass[] | undefined {
  const finished = new Set<DtoClass>();
  const path: DtoClass[] = [];
  const onPath = new Set<DtoClass>();
  const children = (dto: DtoClass): DtoClass[] =>
    isOpen(dto)
      ? []
      : fieldsOf(dto).flatMap((field) =>
          field.element?.kind === "dto" ? [field.element.dto] : [],
        );
  const stack: { dto: DtoClass; next: DtoClass[]; at: number }[] = [];
  const enter = (dto: DtoClass): void => {
    path.push(dto);
    onPath.add(dto);
    stack.push({ dto, next: children(dto), at: 0 });
  };
  enter(root);
  for (let top = stack.at(-1); top !== undefined; top = stack.at(-1)) {
    const child = top.next[top.at];
    top.at += 1;
    if (child === undefined) {
      stack.pop();
      path.pop();
      onPath.delete(top.dto);
      finished.add(top.dto);
    } else if (onPath.has(child)) {
      return [...path.slice(path.indexOf(child)), child];
    } else if (!finished.has(child)) {
      enter(child);
    }
  }
  return undefined;
}

/** `A → B → A`: a cycle as the classes' names. */
export const cycleText = (cycle: readonly DtoClass[]): string =>
  cycle.map((dto) => dto.name).join(" → ");
