export function shouldApplyDocumentRead<T>(
  requestKey: string,
  currentKey: string,
  pendingAtStart: T | undefined,
  pendingNow: T | undefined
): boolean {
  return requestKey === currentKey && pendingAtStart === pendingNow;
}

export class RequestGeneration {
  private generation = 0;

  next(): number {
    this.generation += 1;
    return this.generation;
  }

  invalidate(): void {
    this.generation += 1;
  }

  current(): number {
    return this.generation;
  }

  isCurrent(generation: number): boolean {
    return generation === this.generation;
  }
}

export async function runIdentitySwitch(
  beforeChange: (() => Promise<boolean>) | undefined,
  switchIdentity: () => Promise<void>,
  afterChange: () => void | Promise<void>
): Promise<boolean> {
  if (beforeChange && !(await beforeChange())) return false;
  await switchIdentity();
  await afterChange();
  return true;
}

export function identityQueryAfterSwitch(
  switched: boolean,
  attemptedQuery: string,
  selectedName: string | null | undefined
): string {
  return switched ? attemptedQuery : selectedName ?? "";
}
