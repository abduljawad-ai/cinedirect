import { h } from "preact";
import { useRef, useCallback } from "preact/hooks";
import { signal } from "@preact/signals";
import styles from "../styles/components.module.css";

interface SearchBarProps {
  onSearch: (query: string) => void;
  loading?: boolean;
  initialQuery?: string;
}

export function SearchBar({
  onSearch,
  loading = false,
  initialQuery = "",
}: SearchBarProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const query = signal<string>(initialQuery);

  const submit = useCallback(() => {
    const value = query.value.trim();
    if (value && !loading) {
      onSearch(value);
    }
  }, [onSearch, loading]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        submit();
      }
    },
    [submit],
  );

  const handleInput = useCallback(() => {
    query.value = inputRef.current?.value ?? "";
  }, []);

  return (
    <form
      class={styles.searchBar}
      role="search"
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <input
        ref={inputRef}
        type="search"
        class={styles.searchInput}
        value={query.value}
        onInput={handleInput}
        onKeyDown={handleKeyDown}
        placeholder="Search movies & TV shows…"
        aria-label="Search movies and TV shows"
        aria-busy={loading}
        autocomplete="off"
        spellcheck={false}
      />
      <button
        type="submit"
        class={styles.searchButton}
        disabled={loading}
        aria-label="Search"
      >
        {loading ? <span class={styles.spinner} aria-hidden="true" /> : null}
        {loading ? "Searching…" : "Search"}
      </button>
    </form>
  );
}
