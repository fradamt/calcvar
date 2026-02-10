// constants.js — Subfield colors, author colors, config

export const THREAD_COLORS = {
  classical_calcvar: '#e63946',
  direct_methods: '#457b9d',
  regularity: '#2a9d8f',
  geometric: '#f4a261',
  optimal_control: '#606c38',
  convexity: '#4361ee',
  gamma_convergence: '#7209b7',
  optimal_transport: '#06b6d4',
  free_discontinuity: '#e07c3e',
};

export const THREAD_ORDER = [
  'classical_calcvar', 'direct_methods', 'regularity', 'geometric',
  'optimal_control', 'convexity', 'gamma_convergence', 'optimal_transport',
  'free_discontinuity',
];

export const THREAD_NAMES = {
  classical_calcvar: 'Classical Methods',
  direct_methods: 'Direct Methods',
  regularity: 'Regularity Theory',
  geometric: 'Geometric Problems',
  optimal_control: 'Optimal Control',
  convexity: 'Convexity & Relaxation',
  gamma_convergence: '\u0393-Convergence',
  optimal_transport: 'Optimal Transport',
  free_discontinuity: 'Free Discontinuity',
};

export const AUTHOR_COLORS = [
  '#e63946', '#457b9d', '#2a9d8f', '#e9c46a', '#f4a261',
  '#d62828', '#6a994e', '#bc6c25', '#7209b7', '#4361ee',
  '#606c38', '#9d4edd', '#264653', '#a8dadc', '#b5838d',
];

// Default influence slider threshold (0 = show all)
export const DEFAULT_MIN_INFLUENCE = 0;

// Timeline zoom extent
export const TIMELINE_ZOOM_EXTENT = [1, 8];

// Network zoom extent
export const NETWORK_ZOOM_EXTENT = [0.15, 5];

// Canvas DPR cap
export const MAX_DPR = 2.0;
