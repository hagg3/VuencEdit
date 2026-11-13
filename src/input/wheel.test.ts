import { describe, expect, it } from "vitest";
import {
  GESTURE_GAP_MS, PINCH_GAIN, initialDeviceState, nextDevice, wheelAction, wheelEvidence,
  type WheelDevice, type WheelMode, type WheelSample,
} from "./wheel";

function ev(p: Partial<WheelSample>): WheelSample {
  return { deltaX: 0, deltaY: 0, deltaMode: 0, ctrlKey: false, metaKey: false, shiftKey: false, ...p };
}

const OPTS = { pageH: 800, mouseNotchFactor: 1.1 };

// Shapes seen in the wild: a Windows mouse notch (Chromium), a Mac mouse notch (WebKit:
// wheelDeltaY = −3·deltaY), a trackpad scroll, a Windows precision-touchpad scroll (fractional).
const WIN_NOTCH = ev({ deltaY: 100, wheelDeltaY: -120 });
const MAC_NOTCH = ev({ deltaY: 40, wheelDeltaY: -120 });
const MAC_PAD = ev({ deltaY: 3, wheelDeltaY: -9 });
const WIN_PTP = ev({ deltaY: 2.5, wheelDeltaY: -3 });

describe("wheelEvidence", () => {
  it("reads notched wheels as a mouse", () => {
    expect(wheelEvidence(WIN_NOTCH)).toBe("mouse");
    expect(wheelEvidence(MAC_NOTCH)).toBe("mouse");
    expect(wheelEvidence(ev({ deltaY: 3, deltaMode: 1 }))).toBe("mouse");
  });

  it("reads sideways movement as a trackpad, except Shift+wheel", () => {
    expect(wheelEvidence(ev({ deltaX: 2, deltaY: 1 }))).toBe("trackpad");
    expect(wheelEvidence(ev({ deltaX: 40, shiftKey: true, wheelDeltaY: 0 }))).toBe("unsure");
  });

  it("is unsure about small un-notched deltas", () => {
    expect(wheelEvidence(MAC_PAD)).toBe("unsure");
    expect(wheelEvidence(WIN_PTP)).toBe("unsure");
  });
});

describe("nextDevice", () => {
  it("decides each gesture from its first event", () => {
    let s = nextDevice(initialDeviceState(), WIN_NOTCH, 1000);
    expect(s.device).toBe("mouse");
    s = nextDevice(s, MAC_PAD, 1000 + GESTURE_GAP_MS + 1);
    expect(s.device).toBe("trackpad");
    s = nextDevice(s, WIN_PTP, 2000 + GESTURE_GAP_MS);
    expect(s.device).toBe("trackpad");
  });

  it("never turns a trackpad gesture into a mouse (momentum tails)", () => {
    let s = nextDevice(initialDeviceState(), MAC_PAD, 0);
    s = nextDevice(s, MAC_NOTCH, 16);
    expect(s.device).toBe("trackpad");
  });

  it("corrects a mouse-looking start once the gesture moves sideways", () => {
    let s = nextDevice(initialDeviceState(), MAC_NOTCH, 0);
    expect(s.device).toBe("mouse");
    s = nextDevice(s, ev({ deltaX: 1, deltaY: 6 }), 16);
    expect(s.device).toBe("trackpad");
  });

  it("keeps a fast mouse spin a mouse", () => {
    let s = nextDevice(initialDeviceState(), WIN_NOTCH, 0);
    for (let t = 20; t < 400; t += 20) s = nextDevice(s, ev({ deltaY: 300, wheelDeltaY: -360 }), t);
    expect(s.device).toBe("mouse");
  });
});

describe("wheelAction", () => {
  const kind = (e: WheelSample, d: WheelDevice, m: WheelMode, mac: boolean) => wheelAction(e, d, m, mac, OPTS).kind;

  it("classification table: mac/win × mode × modifiers", () => {
    for (const mac of [true, false]) {
      // auto: trackpad pans, mouse zooms
      expect(kind(MAC_PAD, "trackpad", "auto", mac)).toBe("pan");
      expect(kind(WIN_NOTCH, "mouse", "auto", mac)).toBe("zoom");
      // forced modes
      expect(kind(WIN_NOTCH, "mouse", "pan", mac)).toBe("pan");
      expect(kind(MAC_PAD, "trackpad", "zoom", mac)).toBe("zoom");
      // ctrl (pinch, or Ctrl+wheel) always zooms
      for (const m of ["auto", "pan", "zoom"] as const) {
        expect(kind(ev({ deltaY: -3, ctrlKey: true }), "trackpad", m, mac)).toBe("zoom");
      }
    }
    // ⌘-scroll zooms on a Mac only; the Windows key never does
    expect(kind(ev({ deltaY: 5, metaKey: true }), "trackpad", "pan", true)).toBe("zoom");
    expect(kind(ev({ deltaY: 5, metaKey: true }), "trackpad", "pan", false)).toBe("pan");
  });

  it("a pinch of 40 events at deltaY = −5 zooms ≈ e²", () => {
    let scale = 1;
    for (let i = 0; i < 40; i++) {
      const a = wheelAction(ev({ deltaY: -5, ctrlKey: true }), "trackpad", "auto", true, OPTS);
      if (a.kind !== "zoom") throw new Error("expected zoom");
      scale *= a.factor;
    }
    expect(scale).toBeCloseTo(Math.exp(40 * 5 * PINCH_GAIN), 6);
    expect(scale).toBeCloseTo(Math.E ** 2, 6);
  });

  it("one mouse notch zooms by the pane's notch factor", () => {
    const a = wheelAction(ev({ deltaY: -100, wheelDeltaY: 120 }), "mouse", "auto", false, OPTS);
    expect(a).toEqual({ kind: "zoom", factor: expect.closeTo(1.1, 9) });
  });

  it("pan follows the fingers and honours deltaMode", () => {
    expect(wheelAction(ev({ deltaX: 3, deltaY: -7 }), "trackpad", "auto", true, OPTS)).toEqual({ kind: "pan", dx: -3, dy: 7 });
    expect(wheelAction(ev({ deltaY: 2, deltaMode: 1 }), "mouse", "pan", false, OPTS)).toEqual({ kind: "pan", dx: -0, dy: -32 });
    expect(wheelAction(ev({ deltaY: 1, deltaMode: 2 }), "mouse", "pan", false, OPTS)).toEqual({ kind: "pan", dx: -0, dy: -800 });
  });

  it("Shift+wheel pans sideways when the platform left it on deltaY", () => {
    expect(wheelAction(ev({ deltaY: 100, shiftKey: true }), "mouse", "pan", false, OPTS)).toEqual({ kind: "pan", dx: -100, dy: 0 });
    expect(wheelAction(ev({ deltaX: 40, shiftKey: true }), "trackpad", "auto", true, OPTS)).toEqual({ kind: "pan", dx: -40, dy: -0 });
  });

  it("clamps one huge trackpad event", () => {
    const a = wheelAction(ev({ deltaY: -5000, ctrlKey: true }), "trackpad", "auto", true, OPTS);
    expect(a).toEqual({ kind: "zoom", factor: 2 });
  });
});
