/**
 * Honest placeholders for routes whose screens are not built yet, and the
 * not-found page.
 *
 * A placeholder that says which milestone owns the screen is more useful than
 * a blank page or a spinner that never resolves.
 */

import { Link } from 'react-router-dom'

import { Button, Card, EmptyState, PageHeader } from '../components/ui/index.js'

export function PlaceholderPage({
  title,
  milestone,
  description,
}: {
  title: string
  milestone: string
  description: string
}) {
  return (
    <>
      <PageHeader title={title} />
      <Card>
        <EmptyState
          title={`Coming in ${milestone}`}
          description={description}
          action={
            <Link to="/">
              <Button>Back to home</Button>
            </Link>
          }
        />
      </Card>
    </>
  )
}

export function NotFoundPage() {
  return (
    <Card>
      <EmptyState
        title="Page not found"
        description="That address does not match any screen. It may have been a link to something not built yet."
        action={
          <Link to="/">
            <Button variant="primary">Back to home</Button>
          </Link>
        }
      />
    </Card>
  )
}
