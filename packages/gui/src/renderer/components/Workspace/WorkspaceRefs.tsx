import {
  createContext,
  type ReactNode,
  type RefObject,
  useContext,
  useRef,
} from "react";

interface WorkspaceRefsValue {
  readonly composerRef: RefObject<HTMLFormElement>;
  readonly overlayRef: RefObject<HTMLDivElement>;
  readonly sendButtonRef: RefObject<HTMLButtonElement>;
}

const Ctx = createContext<WorkspaceRefsValue | null>(null);

export function WorkspaceRefsProvider(props: {
  readonly children: ReactNode;
}): JSX.Element {
  const composerRef = useRef<HTMLFormElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const sendButtonRef = useRef<HTMLButtonElement>(null);
  return (
    <Ctx.Provider value={{ composerRef, overlayRef, sendButtonRef }}>
      {props.children}
    </Ctx.Provider>
  );
}

export function useWorkspaceRefs(): WorkspaceRefsValue {
  const v = useContext(Ctx);
  if (v === null) {
    throw new Error(
      "useWorkspaceRefs must be used within a WorkspaceRefsProvider",
    );
  }
  return v;
}
