// Shared spring presets so every surface moves with the same feel. All clamp
// overshoot: motion eases into place and never wobbles past it.
export const snappy = { damping: 26, stiffness: 320, mass: 0.7, overshootClamping: true } as const;
export const settle = { damping: 24, stiffness: 220, mass: 0.8, overshootClamping: true } as const;
export const gentle = { damping: 28, stiffness: 240, mass: 1, overshootClamping: true } as const;
// Travel across several tabs.
export const glide = { damping: 26, stiffness: 320, mass: 0.8, overshootClamping: true } as const;
