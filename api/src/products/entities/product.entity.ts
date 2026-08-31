import {
  Check,
  Column,
  Entity,
  PrimaryColumn,
  UpdateDateColumn,
} from 'typeorm';

@Entity('products')
@Check('remaining_stock >= 0')
export class Product {
  @PrimaryColumn()
  id: string;

  @Column()
  name: string;

  @Column('text')
  description: string;

  @Column('decimal', { precision: 10, scale: 2 })
  price: string;

  @Column({ name: 'total_stock', type: 'int' })
  totalStock: number;

  @Column({ name: 'remaining_stock', type: 'int' })
  remainingStock: number;

  @Column({ name: 'is_flash_sale_active', type: 'boolean', default: false })
  isFlashSaleActive: boolean;

  /**
   * Row version for the optimistic claim strategy.
   *
   * Only STOCK_CLAIM_STRATEGY=optimistic reads or writes it; the pessimistic
   * and atomic strategies leave it untouched. It exists so the three
   * strategies can be benchmarked against the same schema.
   *
   * Deliberately a plain int, not TypeORM's @VersionColumn — @VersionColumn
   * makes TypeORM bump and check the value on every save() of this entity,
   * which would impose optimistic locking on the seeder and on any other
   * writer, not just on the strategy that asked for it.
   */
  @Column({ type: 'int', default: 0 })
  version: number;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
