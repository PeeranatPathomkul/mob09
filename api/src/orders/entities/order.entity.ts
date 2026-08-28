import { Column, CreateDateColumn, Entity, Index, PrimaryGeneratedColumn, Unique } from 'typeorm';

export enum OrderStatus {
  PENDING = 'pending',
  CONFIRMED = 'confirmed',
  FAILED = 'failed',
}

@Entity('orders')
// Enforces "one unit per user per product" and, as a side effect, creates the
// composite (user_id, product_id) index — which is what the duplicate check
// after a 23505 looks the row up by. No separate index is needed for it.
@Unique(['userId', 'productId'])
// Deliberately NOT a hot-path optimisation, and it should not be sold as one:
// the stock decrement finds its row in `products` by primary key and never
// touches this table's indexes. What this covers is the per-product
// aggregation the verification queries run ("how many orders for p-1001?"),
// which the composite index above cannot serve because product_id is its
// trailing column. At 50 rows Postgres will still choose a seq scan; this
// earns its keep once the table is large.
@Index(['productId'])
export class Order {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ name: 'user_id' })
  userId!: string;

  @Column({ name: 'product_id' })
  productId!: string;

  @Column({ type: 'int', default: 1 })
  quantity!: number;

  @Column({ type: 'enum', enum: OrderStatus, default: OrderStatus.PENDING })
  status!: OrderStatus;

  /**
   * Which BullMQ job created this row.
   *
   * This is what makes a 23505 unique violation readable: if the existing
   * row carries the same job_id we are currently running, this job already
   * committed and is simply being replayed after a crash — not a second
   * purchase attempt. Nullable so rows written before this column existed
   * (and any future non-queue writer) stay valid.
   */
  @Column({ name: 'job_id', type: 'varchar', nullable: true })
  jobId!: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt!: Date;
}
