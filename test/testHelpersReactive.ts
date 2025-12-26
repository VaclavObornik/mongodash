import { find } from 'lodash';
import { Document } from 'mongodb';
import { MetricObjectWithValues, MetricValue } from 'prom-client';

/**
 * Interface for the Globals Registry Document used in monitoring tests.
 */
export interface GlobalsRegistryDoc extends Document {
    _id: string;
    instances: Record<string, any>;
}

/**
 * Finds a metric by name from the JSON array returned by registry.getMetricsAsJSON()
 */
export function getMetric(metrics: MetricObjectWithValues<MetricValue<string>>[], name: string): MetricObjectWithValues<MetricValue<string>> {
    const metric = find(metrics, { name });
    if (!metric) {
        throw new Error(`Metric '${name}' not found in registry`);
    }
    return metric;
}

/**
 * Finds a specific value entry within a metric by matching labels.
 */
export function getMetricValue(
    metric: MetricObjectWithValues<MetricValue<string>>,
    labels: Record<string, string>,
    throwIfMissing: false,
): MetricValue<string> | undefined;
export function getMetricValue(metric: MetricObjectWithValues<MetricValue<string>>, labels: Record<string, string>, throwIfMissing?: true): MetricValue<string>;
export function getMetricValue(
    metric: MetricObjectWithValues<MetricValue<string>>,
    labels: Record<string, string>,
    throwIfMissing = true,
): MetricValue<string> | undefined {
    const val = find(metric.values, (v) => {
        // v is MetricValue<string>
        if (!v.labels) return false;
        for (const [key, value] of Object.entries(labels)) {
            if (v.labels[key] !== value) return false;
        }
        return true;
    });

    if (!val) {
        if (throwIfMissing) {
            throw new Error(`Metric value for '${metric.name}' not found with labels: ${JSON.stringify(labels)}`);
        }
        return undefined;
    }
    return val;
}

/**
 * Helper to assert a metric value exists and (optionally) equals a number.
 * Note: prom-client may return values as numbers or strings depending on configuration,
 * but typical usage here expects numbers.
 */
export function assertMetricValue(
    metrics: MetricObjectWithValues<MetricValue<string>>[],
    name: string,
    labels: Record<string, string>,
    expectedValue?: number,
): void {
    const metric = getMetric(metrics, name);
    const val = getMetricValue(metric, labels);

    if (expectedValue !== undefined) {
        // value in MetricValue is strictly typed as number in newer prom-client
        expect(val.value).toBe(expectedValue);
    }
}
