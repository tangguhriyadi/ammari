import { Card, LoadingRegion, Skeleton } from "@ammari/ui";
import { BreadcrumbSkeleton, FormFieldsSkeleton, PageHeaderSkeleton } from "@/components/page-skeleton";

const STEP_COUNT = 5;

/** Loading state for the product stepper pages (/products/new, /products/[id], /products/[id]/setup):
 * optional thumbnail beside the header, then the stepper card with the info step's form. */
export function ProductStepSkeleton({ thumbnail = true, action = false }: { thumbnail?: boolean; action?: boolean }) {
  return (
    <LoadingRegion>
      <BreadcrumbSkeleton />
      <div className="flex items-start gap-4">
        {thumbnail && (
          <div className="shrink-0 pb-6">
            <Skeleton className="size-16 rounded-lg sm:size-20" />
          </div>
        )}
        <div className="flex-1">
          <PageHeaderSkeleton description={false} action={action} />
        </div>
      </div>
      <Card className="p-0">
        <div className="px-4 py-4 lg:px-6">
          <ol className="flex items-start">
            {Array.from({ length: STEP_COUNT }, (_, index) => (
              <li key={index} className={index === STEP_COUNT - 1 ? "flex min-w-0 items-start" : "flex min-w-0 flex-1 items-start"}>
                <Skeleton className="size-8 shrink-0 rounded-full" />
                {index < STEP_COUNT - 1 && <span aria-hidden="true" className="mx-1.5 mt-4 h-px min-w-3 flex-1 bg-neutral-200 lg:mx-3" />}
              </li>
            ))}
          </ol>
        </div>
        <div className="border-t border-neutral-200" role="presentation" />
        <div className="px-4 py-6 lg:px-6">
          <div className="max-w-2xl">
            <FormFieldsSkeleton fields={8} />
          </div>
        </div>
      </Card>
    </LoadingRegion>
  );
}
