import type { GlobalPoint, LocalPoint, Polygon } from "./types";
export declare function polygon<Point extends GlobalPoint | LocalPoint>(...points: Point[]): Polygon<Point>;
export declare function polygonFromPoints<Point extends GlobalPoint | LocalPoint>(points: Point[]): Polygon<Point>;
export declare const polygonIncludesPoint: <Point extends LocalPoint | GlobalPoint>(point: Point, polygon: Polygon<Point>) => boolean;
export declare const pointOnPolygon: <Point extends LocalPoint | GlobalPoint>(p: Point, poly: Polygon<Point>, threshold?: number) => boolean;
