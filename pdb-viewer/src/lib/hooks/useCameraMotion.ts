/*
 Title: useCameraMotion
 Description: Tracks camera motion state for OrbitControls to gate hover raycasts.
 Provides refs and handlers for onStart/onChange/onEnd and manages an idle timer.
*/
import { useEffect, useRef } from "react";

export interface CameraMotionApi {
  isCameraMoving: React.MutableRefObject<boolean>;
  onControlsStart: () => void;
  onControlsChange: () => void;
  onControlsEnd: () => void;
}

export function useCameraMotion(idleMs: number = 120): CameraMotionApi {
  const isCameraMoving = useRef<boolean>(false);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (timer.current !== null) {
        clearTimeout(timer.current);
        timer.current = null;
      }
    };
  }, []);

  const kickIdle = () => {
    isCameraMoving.current = true;
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = window.setTimeout(() => {
      isCameraMoving.current = false;
    }, idleMs);
  };

  const onControlsStart = () => {
    isCameraMoving.current = true;
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  };

  const onControlsChange = () => {
    kickIdle();
  };

  const onControlsEnd = () => {
    kickIdle();
  };

  return { isCameraMoving, onControlsStart, onControlsChange, onControlsEnd };
}
